#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command } from "commander";
import { loadConfig, ActionPolicy, type RuntimeConfig } from "./config/index.js";
import { createLogger } from "./core/logger.js";
import { ExempclawError } from "./core/errors.js";
import { estimateCostUsd } from "./core/usage.js";
import { loadAgentConfig } from "./agent/config.js";
import type { RunHooks } from "./agent/agent.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { FileMemoryStore } from "./memory/file-store.js";
import { ClaudeClient } from "./llm/claude.js";
import { ingestArchive } from "./ingest/ingest.js";
import { createTerminalApprover } from "./cli/approve.js";
import { bold, cyan, dim, usageLine } from "./cli/render.js";
import { runInit, type InitFlags } from "./cli/init.js";
import { runConnectors, runCosts, runDoctor, runHistory, runMemory } from "./cli/offline.js";

const program = new Command();

program
  .name("exempclaw")
  .description("Run Claude-powered agents that take over a departed employee's role.")
  .version("0.2.0");

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
  .option("--json", "print the full run result as JSON")
  .action(async (agentConfigPath: string, input: string, opts: { policy?: string; json?: boolean }) => {
    const { orchestrator, agentId } = await bootstrapSingleAgent(agentConfigPath, opts.policy);
    try {
      const result = await orchestrator.dispatch(agentId, input, { trigger: { kind: "cli", detail: "run" } });
      if (opts.json) {
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        stdout.write(`\n${result.text}\n`);
        stdout.write(`${usageLine(result.usage, result.costUsd, result.iterations)}\n`);
      }
    } finally {
      await orchestrator.shutdown();
    }
  });

program
  .command("chat")
  .description("Open an interactive REPL with a single agent (streams live).")
  .argument("<agentConfig>", "path to an agent config JSON file")
  .option("--policy <policy>", "override outward-action policy: ask | auto | deny")
  .action(async (agentConfigPath: string, opts: { policy?: string }) => {
    const { orchestrator, agentId, name } = await bootstrapSingleAgent(agentConfigPath, opts.policy);
    stdout.write(`Chatting with ${bold(name)} ${dim(`(agent: ${agentId})`)}. Type "exit" to quit.\n`);

    const hooks: RunHooks = {
      onText: (delta) => stdout.write(delta),
      onToolStart: (tool, input) =>
        stdout.write(`\n${dim(`⚙ ${tool} ${truncateLine(JSON.stringify(input), 140)}`)}\n`),
      onToolEnd: (tool, okFlag, detail) =>
        okFlag ? undefined : stdout.write(`${dim(`↳ ${tool} failed${detail ? `: ${detail}` : ""}`)}\n`),
    };

    const rl = createInterface({ input: stdin, output: stdout });
    try {
      for (;;) {
        const line = (await rl.question(`\n${cyan("you ›")} `)).trim();
        if (line === "exit" || line === "quit") break;
        if (!line) continue;
        stdout.write(`\n${bold(`${name} ›`)} `);
        const result = await orchestrator.dispatch(agentId, line, {
          hooks,
          trigger: { kind: "chat" },
        });
        stdout.write(`\n${usageLine(result.usage, result.costUsd, result.iterations)}\n`);
      }
    } finally {
      rl.close();
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

    stdout.write(`Ingesting ${dir} for agent ${bold(agentCfg.id)} (model ${model})…\n`);
    const result = await ingestArchive({
      dir,
      persona: agentCfg.persona,
      memory,
      claude,
      model,
      log,
      maxChunks: Number(opts.maxChunks),
      briefing: opts.briefing,
      onProgress: (note) => stdout.write(`${dim(`· ${note}`)}\n`),
    });

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
  .command("doctor")
  .description("Check the environment: Node version, API key, connector credentials.")
  .action(runDoctor);

async function bootstrapSingleAgent(agentConfigPath: string, policyOverride?: string) {
  const config = applyPolicyOverride(loadConfig(), policyOverride);
  const log = createLogger(config.logLevel);
  const orchestrator = new Orchestrator(config, log, createTerminalApprover());
  const cfg = await loadAgentConfig(agentConfigPath);
  await orchestrator.addAgent(cfg);
  return { orchestrator, agentId: cfg.id, name: cfg.persona.name };
}

function applyPolicyOverride(config: RuntimeConfig, policy?: string): RuntimeConfig {
  if (!policy) return config;
  const parsed = ActionPolicy.safeParse(policy);
  if (!parsed.success) {
    throw new ExempclawError(`invalid --policy "${policy}" (use ask, auto, or deny)`);
  }
  return { ...config, actionPolicy: parsed.data };
}

function truncateLine(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

program.parseAsync().catch((err: unknown) => {
  if (err instanceof ExempclawError) {
    process.stderr.write(`\n✖ ${err.message}\n`);
  } else {
    process.stderr.write(`\n✖ Unexpected error: ${(err as Error).stack ?? String(err)}\n`);
  }
  process.exit(1);
});
