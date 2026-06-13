#!/usr/bin/env node
import { stdout } from "node:process";
import { Command } from "commander";
import { loadConfig, loadOfflineConfig, ActionPolicy, type RuntimeConfig } from "./config/index.js";
import { createLogger } from "./core/logger.js";
import { ExempclawError } from "./core/errors.js";
import { estimateCostUsd } from "./core/usage.js";
import { loadAgentConfig } from "./agent/config.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { FileMemoryStore } from "./memory/file-store.js";
import { ClaudeClient } from "./llm/claude.js";
import { ingestArchive } from "./ingest/ingest.js";
import { startDashboard } from "./dashboard/server.js";
import type { AgentMeta } from "./dashboard/data.js";
import { createTerminalApprover } from "./cli/approve.js";
import { bold, cyan, dim, usageLine } from "./cli/render.js";
import { Stage, flashLine, progressBar } from "./cli/tui.js";
import { liveRunHooks } from "./cli/live.js";
import { runChatSession } from "./cli/chat.js";
import { runInit, type InitFlags } from "./cli/init.js";
import { runDemo } from "./cli/demo.js";
import { bootstrapDemo } from "./demo/bootstrap.js";
import { runConnectors, runCosts, runDoctor, runHistory, runMemory } from "./cli/offline.js";

const program = new Command();

program
  .name("exempclaw")
  .description("Run Claude-powered agents that take over a departed employee's role.")
  .version("0.3.0");

program
  .command("init")
  .description("Scaffold a new agent config JSON (interactive unless flags cover it).")
  .argument("<path>", "where to write the agent config, e.g. agents/sam.json")
  .option("--id <id>")
  .option("--name <name>", "persona name")
  .option("--role <role>", "role being taken over")
  .option("--succeeds <person>", "the departed employee")
  .option("--tone <tone>")
  .option("--guidance <text>")
  .option("--disclosure <mode>", "transparent | on_request | opaque")
  .option("--connectors <ids>", "comma-separated, e.g. email,slack")
  .option("--force", "overwrite if the file exists")
  .option("--yes", "non-interactive; use defaults for anything not flagged")
  .action(async (path: string, flags: InitFlags) => {
    await runInit(path, flags);
  });

program
  .command("run")
  .description("Run a single agent on one input and print the result.")
  .argument("<agentConfig>", "path to an agent config JSON file")
  .argument("<input>", "the message / instruction to give the agent")
  .option("--policy <policy>", "override outward-action policy: ask | auto | deny")
  .option("--json", "print the full run result as JSON (disables animations)")
  .action(async (agentConfigPath: string, input: string, opts: { policy?: string; json?: boolean }) => {
    const stage = new Stage({ tty: opts.json ? false : undefined });
    const animate = !opts.json && stage.isAnimated;
    const { orchestrator, agentId, name } = await bootstrapSingleAgent(agentConfigPath, opts.policy, stage);

    const running = new AbortController();
    const onSigint = () => running.abort();
    process.on("SIGINT", onSigint);
    try {
      const live = animate ? liveRunHooks(stage, name) : undefined;
      const result = await orchestrator.dispatch(agentId, input, {
        trigger: { kind: "cli", detail: "run" },
        ...(live ? { hooks: live.hooks } : {}),
        signal: running.signal,
      });
      live?.finish({ interrupted: result.stopReason === "interrupted" });
      if (opts.json) {
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (animate) {
        // text already streamed above the live region
        stdout.write(`\n${usageLine(result.usage, result.costUsd, result.iterations)}\n`);
      } else {
        stdout.write(`\n${result.text}\n`);
        stdout.write(`${usageLine(result.usage, result.costUsd, result.iterations)}\n`);
      }
      if (result.stopReason === "interrupted") process.exitCode = 130;
    } finally {
      process.removeListener("SIGINT", onSigint);
      stage.stopAll();
      await orchestrator.shutdown();
    }
  });

program
  .command("chat")
  .description("Open an interactive REPL with a single agent (streams live, animated).")
  .argument("<agentConfig>", "path to an agent config JSON file")
  .option("--policy <policy>", "override outward-action policy: ask | auto | deny")
  .action(async (agentConfigPath: string, opts: { policy?: string }) => {
    const stage = new Stage();
    const { orchestrator, agentId, name, model } = await bootstrapSingleAgent(agentConfigPath, opts.policy, stage);
    try {
      await runChatSession({ orchestrator, agentId, name, model, stage });
    } finally {
      await orchestrator.shutdown();
    }
  });

program
  .command("start")
  .description("Load one or more agents and run the fleet: listen for events, fire schedules.")
  .argument("<agentConfigs...>", "paths to agent config JSON files")
  .option("--policy <policy>", "override outward-action policy: ask | auto | deny")
  .action(async (paths: string[], opts: { policy?: string }) => {
    const config = applyPolicyOverride(loadConfig(), opts.policy);
    const log = createLogger(config.logLevel);
    const orchestrator = new Orchestrator(config, log, createTerminalApprover());
    for (const path of paths) {
      const cfg = await loadAgentConfig(path);
      await orchestrator.addAgent(cfg);
    }
    // One-shot flash per inbound event; serialized so bursts don't interleave.
    let flashQueue: Promise<void> = Promise.resolve();
    orchestrator.onInboundEvent = (agentId, event) => {
      flashQueue = flashQueue.then(() =>
        flashLine(`${event.type} ${dim(`(${event.threadId})`)} → ${bold(agentId)}`),
      );
    };
    const stop = () => {
      void orchestrator.shutdown().then(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await orchestrator.start();
  });

program
  .command("ingest")
  .description("Onboarding pass: distill a directory of exported work artifacts into agent memory.")
  .argument("<agentConfig>", "path to an agent config JSON file")
  .argument("<dir>", "directory of exported files (.txt, .md, .eml, .json, …)")
  .option("--model <model>", "model to use for distillation (defaults to the agent's model)")
  .option("--max-chunks <n>", "cap distillation calls to bound cost", "60")
  .option("--no-briefing", "skip the final role-briefing synthesis")
  .action(async (agentConfigPath: string, dir: string, opts: { model?: string; maxChunks: string; briefing: boolean }) => {
    const config = loadConfig();
    const log = createLogger(config.logLevel);
    const agentCfg = await loadAgentConfig(agentConfigPath);
    const memory = new FileMemoryStore(config.dataDir, agentCfg.id);
    const claude = new ClaudeClient(config.anthropicApiKey, config.defaultModel, log);
    const model = opts.model ?? agentCfg.model ?? config.defaultModel;

    const stage = new Stage();
    stage.print(`Ingesting ${dir} for agent ${bold(agentCfg.id)} ${dim(`(model ${model})`)}\n`);
    stage.addRow("scan", { anim: "searching", icon: "◇", label: "scanning archive" });
    const result = await ingestArchive({
      dir,
      persona: agentCfg.persona,
      memory,
      claude,
      model,
      log,
      maxChunks: Number(opts.maxChunks),
      briefing: opts.briefing,
      onProgress: (event) => {
        switch (event.phase) {
          case "scanned":
            stage.settleRow("scan", {
              label: "scanned archive",
              suffix: dim(`${event.files} file(s)${event.skipped ? `, ${event.skipped} skipped` : ""}`),
            });
            break;
          case "chunk":
            stage.addRow("distill", {
              anim: "reading",
              icon: "▥",
              label: `distilling ${event.files[0] ?? ""}${event.files.length > 1 ? ` +${event.files.length - 1}` : ""}`,
              hint: `${progressBar(event.index - 1, event.total)} ${event.index}/${event.total}`,
            });
            break;
          case "briefing":
            stage.settleRow("distill", { label: "distilled archive" });
            stage.addRow("brief", { anim: "writing", icon: "✎", label: "synthesizing role briefing" });
            break;
        }
      },
    });
    stage.settleRow("distill", { label: "distilled archive" });
    stage.settleRow("brief", { label: "role briefing ready" });
    stage.stopAll();

    stdout.write(`\nIngested ${result.files} file(s) in ${result.chunks} chunk(s) → ${bold(String(result.memoriesAdded))} memories.\n`);
    if (result.skippedFiles.length > 0) {
      stdout.write(dim(`Skipped: ${result.skippedFiles.slice(0, 10).join(", ")}${result.skippedFiles.length > 10 ? "…" : ""}\n`));
    }
    if (result.briefing) {
      stdout.write(`\n${bold("Role briefing")}\n${result.briefing}\n`);
    }
    stdout.write(`${usageLine(result.usage, estimateCostUsd(model, result.usage), result.usage.turns)}\n`);
  });

program
  .command("memory")
  .description("Inspect or edit an agent's durable memory.")
  .argument("<agentConfig>", "path to an agent config JSON file")
  .option("--search <query>", "keyword search instead of listing recent")
  .option("--add <text>", "store a memory as the operator")
  .option("--tags <tags>", "comma-separated tags for --add")
  .option("--rm <id>", "remove a memory by id (or id prefix)")
  .option("--limit <n>", "how many to show", "20")
  .action(runMemory);

program
  .command("history")
  .description("Show (or clear) an agent's conversation history.")
  .argument("<agentConfig>", "path to an agent config JSON file")
  .option("--limit <n>", "how many messages to show", "20")
  .option("--clear", "delete the conversation history (memories are kept)")
  .option("--force", "skip the confirmation prompt for --clear")
  .action(runHistory);

program
  .command("costs")
  .description("Token usage and estimated spend per agent, from the run log.")
  .option("--agent <id>", "limit to one agent id")
  .action(runCosts);

program
  .command("connectors")
  .description("List connectors and whether their credentials are configured.")
  .action(runConnectors);

program
  .command("dashboard")
  .description("Serve the local read-only fleet dashboard (runs, approvals, costs, memory).")
  .argument("[agentConfigs...]", "agent config JSONs to enrich the view with persona details")
  .option("--port <n>", "port to listen on (127.0.0.1 only)", "4177")
  .action(async (paths: string[], opts: { port: string }) => {
    const config = loadOfflineConfig();
    const log = createLogger(config.logLevel);
    const metas = new Map<string, AgentMeta>();
    for (const path of paths) {
      const cfg = await loadAgentConfig(path);
      metas.set(cfg.id, {
        persona: cfg.persona,
        model: cfg.model ?? config.defaultModel,
        connectors: cfg.connectors,
      });
    }
    const { url } = await startDashboard({ dataDir: config.dataDir, port: Number(opts.port), metas, log });
    stdout.write(`${bold("Succession Ledger")} serving at ${cyan(url)}\n`);
    stdout.write(dim(`data dir: ${config.dataDir} · ${metas.size} dossier(s) enriched · Ctrl-C to stop\n`));
    await new Promise(() => undefined); // run until killed
  });

program
  .command("doctor")
  .description("Check the environment: Node, API key, and live connector probes.")
  .option("--no-probe", "skip live connectivity probes (credential presence only)")
  .action((opts: { probe: boolean }) => runDoctor({ probe: opts.probe }));

const plugin = program.command("plugin").description("Manage plugins (~/.exempclaw/plugins).");

plugin
  .command("create <name>")
  .description("Scaffold a new plugin folder with a working example tool.")
  .action(async (name: string) => {
    const { scaffoldPlugin } = await import("./plugins/scaffold.js");
    const { defaultPluginsDir } = await import("./plugins/loader.js");
    const dir = await scaffoldPlugin(defaultPluginsDir(), name);
    stdout.write(`Created ${bold(dir)}\nEdit ${dir}/index.js, then run ${cyan("exempclaw")} → Plugins to see it loaded.\n`);
  });

plugin
  .command("list")
  .description("List discovered plugins and any load errors.")
  .action(async () => {
    const { loadPlugins, defaultPluginsDir } = await import("./plugins/loader.js");
    const result = await loadPlugins();
    stdout.write(dim(`plugins dir: ${defaultPluginsDir()}\n`));
    if (result.plugins.length === 0 && result.failures.length === 0) {
      stdout.write("No plugins installed. Try: exempclaw plugin create my-plugin\n");
      return;
    }
    for (const p of result.plugins) {
      const provides = [
        p.spec.tools?.length ? `${p.spec.tools.length} tool(s)` : "",
        p.spec.connectors?.length ? `${p.spec.connectors.length} connector(s)` : "",
      ].filter(Boolean).join(", ");
      stdout.write(`✓ ${bold(p.manifest.name)} ${p.manifest.version} ${dim(provides || "nothing exported")}\n`);
    }
    for (const f of result.failures) {
      stdout.write(`✗ ${bold(f.name)} ${dim(f.error)}\n`);
    }
  });

program
  .command("ui")
  .description("Open the full-screen fleet UI (the same thing bare `exempclaw` does).")
  .action(async () => {
    const { startUi } = await import("./ui/start.js");
    await startUi();
  });

const demo = program
  .command("demo")
  .description("Try Exempclaw with no API key: an animated tour, or a fully interactive offline demo.")
  .action(runDemo); // bare `exempclaw demo` plays the animated tour

demo
  .command("chat")
  .description("Interactive offline demo: a scripted brain + fictional Initech workspace, real runtime.")
  .option("--policy <policy>", "outward-action policy for the demo: ask | auto | deny (default ask)")
  .action(async (opts: { policy?: string }) => {
    const stage = new Stage();
    const policy = opts.policy ? parsePolicy(opts.policy) : undefined;
    const { orchestrator, agentId, name, model } = await bootstrapDemo({
      policy,
      approve: createTerminalApprover(stage),
    });
    try {
      await runChatSession({
        orchestrator,
        agentId,
        name,
        model,
        stage,
        notice:
          "offline demo — scripted brain, fictional Initech inbox, $0.00 spend; the approval prompts and memory are the real thing",
      });
    } finally {
      await orchestrator.shutdown();
    }
  });

demo
  .command("run <input>")
  .description("One-shot offline demo run (try: \"Anything from Initech overnight?\").")
  .option("--policy <policy>", "outward-action policy: ask | auto | deny (default ask)")
  .option("--json", "print the full run result as JSON (disables animations)")
  .action(async (input: string, opts: { policy?: string; json?: boolean }) => {
    const stage = new Stage({ tty: opts.json ? false : undefined });
    const animate = !opts.json && stage.isAnimated;
    const policy = opts.policy ? parsePolicy(opts.policy) : undefined;
    const { orchestrator, agentId, name } = await bootstrapDemo({
      policy,
      approve: createTerminalApprover(stage),
    });
    try {
      const live = animate ? liveRunHooks(stage, name) : undefined;
      const result = await orchestrator.dispatch(agentId, input, {
        trigger: { kind: "cli", detail: "demo run" },
        ...(live ? { hooks: live.hooks } : {}),
      });
      live?.finish();
      if (opts.json) {
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (animate) {
        stdout.write(`\n${usageLine(result.usage, result.costUsd, result.iterations)}\n`);
      } else {
        stdout.write(`\n${result.text}\n`);
        stdout.write(`${usageLine(result.usage, result.costUsd, result.iterations)}\n`);
      }
    } finally {
      stage.stopAll();
      await orchestrator.shutdown();
    }
  });

async function bootstrapSingleAgent(agentConfigPath: string, policyOverride?: string, stage?: Stage) {
  const config = applyPolicyOverride(loadConfig(), policyOverride);
  const log = createLogger(config.logLevel);
  const orchestrator = new Orchestrator(config, log, createTerminalApprover(stage));
  const cfg = await loadAgentConfig(agentConfigPath);
  await orchestrator.addAgent(cfg);
  return {
    orchestrator,
    agentId: cfg.id,
    name: cfg.persona.name,
    model: cfg.model ?? config.defaultModel,
  };
}

function parsePolicy(policy: string): ActionPolicy {
  const parsed = ActionPolicy.safeParse(policy);
  if (!parsed.success) {
    throw new ExempclawError(`invalid --policy "${policy}" (use ask, auto, or deny)`);
  }
  return parsed.data;
}

function applyPolicyOverride(config: RuntimeConfig, policy?: string): RuntimeConfig {
  if (!policy) return config;
  return { ...config, actionPolicy: parsePolicy(policy) };
}

async function main(): Promise<void> {
  // Bare `exempclaw` opens the fleet UI — but only with a real interactive
  // terminal. ink needs raw-mode stdin; without a TTY (pipes, CI) fall back to
  // help text instead of crashing on setRawMode.
  if (process.argv.slice(2).length === 0) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const { startUi } = await import("./ui/start.js");
      await startUi();
      return;
    }
    program.outputHelp();
    return;
  }
  await program.parseAsync();
}

main().catch((err: unknown) => {
  if (err instanceof ExempclawError) {
    process.stderr.write(`\n✖ ${err.message}\n`);
  } else {
    process.stderr.write(`\n✖ Unexpected error: ${(err as Error).stack ?? String(err)}\n`);
  }
  process.exit(1);
});
