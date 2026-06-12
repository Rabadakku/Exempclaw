import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { addTotals, emptyUsage, estimateCostUsd, formatUsd, type UsageTotals } from "../core/usage.js";
import { bold, cyan, dim, usageLine, yellow } from "./render.js";
import { Stage, playBanner } from "./tui.js";
import { liveRunHooks } from "./live.js";

/**
 * The interactive REPL. Streams the agent's text live, animates tool calls
 * and the agent's own status signals, supports slash commands, and lets
 * Ctrl-C interrupt the current run without killing the session.
 */
export async function runChatSession(opts: {
  orchestrator: Orchestrator;
  agentId: string;
  name: string;
  model: string;
  stage: Stage;
  /** Extra line under the banner (demo mode uses this). */
  notice?: string;
}): Promise<void> {
  const { orchestrator, agentId, name, stage } = opts;

  await playBanner(`succession ledger · chatting with ${name}`, { tty: stage.isAnimated });
  stdout.write(`${dim(`agent ${agentId} · model ${opts.model} · /help for commands · Ctrl-C interrupts a run`)}\n`);
  if (opts.notice) stdout.write(`${yellow("◈")} ${dim(opts.notice)}\n`);

  let sessionUsage: UsageTotals = emptyUsage();
  let sessionCost = 0;
  let hasCost = false;
  let running: AbortController | undefined;

  // Ctrl-C during a run interrupts that run; at the prompt it exits cleanly.
  const onSigint = () => {
    if (running) {
      running.abort();
    } else {
      process.exit(0);
    }
  };
  process.on("SIGINT", onSigint);

  const rl = createInterface({ input: stdin, output: stdout });
  rl.on("SIGINT", onSigint);

  try {
    for (;;) {
      let line: string;
      try {
        line = (await rl.question(`\n${cyan("you ›")} `)).trim();
      } catch {
        break; // readline closed
      }
      if (!line) continue;

      if (line.startsWith("/") || line === "exit" || line === "quit") {
        const handled = await handleCommand(line, { orchestrator, agentId, rl, sessionUsage, sessionCost, hasCost });
        if (handled === "exit") break;
        if (handled === "handled") continue;
        // fall through: not a recognized command — treat as a message
      }

      const live = liveRunHooks(stage, name);
      running = new AbortController();
      let interrupted = false;
      try {
        const result = await orchestrator.dispatch(agentId, line, {
          hooks: live.hooks,
          trigger: { kind: "chat" },
          signal: running.signal,
        });
        interrupted = result.stopReason === "interrupted";
        sessionUsage = addTotals(sessionUsage, result.usage);
        if (result.costUsd !== null) {
          sessionCost += result.costUsd;
          hasCost = true;
        }
        live.finish({ interrupted });
        if (interrupted) {
          stdout.write(`\n${yellow("— interrupted")} ${dim("(history saved; keep typing to continue)")}\n`);
        } else {
          stdout.write(`\n${usageLine(result.usage, result.costUsd, result.iterations)}\n`);
        }
      } catch (err) {
        live.finish();
        stdout.write(`\n${yellow("✖")} ${(err as Error).message}\n`);
      } finally {
        running = undefined;
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    stage.stopAll();
    rl.close();
  }
}

type CommandResult = "exit" | "handled" | "passthrough";

async function handleCommand(
  line: string,
  ctx: {
    orchestrator: Orchestrator;
    agentId: string;
    rl: Interface;
    sessionUsage: UsageTotals;
    sessionCost: number;
    hasCost: boolean;
  },
): Promise<CommandResult> {
  const [command, ...rest] = line.split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (command) {
    case "exit":
    case "quit":
    case "/exit":
    case "/quit":
      return "exit";

    case "/help":
      stdout.write(
        [
          `${bold("/memory <query>")}  search the agent's durable memory`,
          `${bold("/cost")}            session token + spend totals`,
          `${bold("/clear")}           wipe conversation history (memories kept)`,
          `${bold("/exit")}            leave the chat`,
          dim("anything else is sent to the agent · Ctrl-C interrupts a running turn"),
        ].join("\n") + "\n",
      );
      return "handled";

    case "/cost": {
      const u = ctx.sessionUsage;
      stdout.write(
        `${bold("session")}  ${u.turns} turns · ${u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens} in / ${u.outputTokens} out` +
          ` · cached ${u.cacheReadTokens} · ${ctx.hasCost ? formatUsd(ctx.sessionCost) : "n/a"}\n` +
          `${dim("lifetime totals: exempclaw costs")}\n`,
      );
      return "handled";
    }

    case "/memory": {
      const { memory } = ctx.orchestrator.resources(ctx.agentId);
      const hits = arg ? await memory.searchMemory(arg, 10) : (await memory.allMemories()).slice(-10);
      if (hits.length === 0) {
        stdout.write(`${dim(arg ? "no matching memories" : "no memories yet")}\n`);
        return "handled";
      }
      for (const m of hits) {
        stdout.write(`${dim(m.id.slice(0, 8))} ${cyan(`[${m.source}]`)} ${m.text}\n`);
      }
      return "handled";
    }

    case "/clear": {
      const answer = (await ctx.rl.question(`${yellow("clear conversation history?")} [y/N] `)).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        const { memory } = ctx.orchestrator.resources(ctx.agentId);
        await memory.clearHistory();
        stdout.write(`${dim("history cleared (durable memories kept)")}\n`);
      } else {
        stdout.write(`${dim("kept")}\n`);
      }
      return "handled";
    }

    default:
      if (command!.startsWith("/")) {
        stdout.write(`${dim(`unknown command ${command} — /help lists commands`)}\n`);
        return "handled";
      }
      return "passthrough";
  }
}
