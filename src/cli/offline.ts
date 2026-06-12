import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type Anthropic from "@anthropic-ai/sdk";
import { loadOfflineConfig } from "../config/index.js";
import { createLogger } from "../core/logger.js";
import { RunLog } from "../core/run-log.js";
import { addTotals, emptyUsage, estimateCostUsd, formatUsd } from "../core/usage.js";
import { FileMemoryStore } from "../memory/file-store.js";
import { loadAgentConfig } from "../agent/config.js";
import { connectorStatuses, createConnector } from "../connectors/index.js";
import { ClaudeClient } from "../llm/claude.js";
import { bold, cyan, dim, fail, formatTokens, ok, table, warn } from "./render.js";
import { Stage, toolIcon } from "./tui.js";
import { PROBES } from "./probe.js";

/**
 * CLI commands that work on local state only (no Anthropic key required,
 * except doctor's optional API ping).
 */

export async function runMemory(
  agentConfigPath: string,
  opts: { search?: string; add?: string; tags?: string; rm?: string; limit: string },
): Promise<void> {
  const config = loadOfflineConfig();
  const agent = await loadAgentConfig(agentConfigPath);
  const store = new FileMemoryStore(config.dataDir, agent.id);
  const limit = Number(opts.limit);

  if (opts.add) {
    const entry = await store.addMemory({
      text: opts.add,
      source: "operator",
      tags: (opts.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    });
    stdout.write(`Stored ${entry.id}\n`);
    return;
  }
  if (opts.rm) {
    const removed = await store.removeMemory(opts.rm);
    stdout.write(removed ? `Removed ${opts.rm}\n` : `No memory matching "${opts.rm}"\n`);
    return;
  }

  const memories = opts.search ? await store.searchMemory(opts.search, limit) : (await store.allMemories()).slice(-limit);
  if (memories.length === 0) {
    stdout.write(opts.search ? "No matching memories.\n" : "No memories yet. Run `ingest` or let the agent remember things.\n");
    return;
  }
  for (const m of memories) {
    stdout.write(
      `${dim(m.id.slice(0, 8))} ${cyan(`[${m.source}]`)} ${m.text}${m.tags.length ? ` ${dim(m.tags.map((t) => `#${t}`).join(" "))}` : ""}\n`,
    );
  }
  stdout.write(dim(`\n${memories.length} shown · agent ${agent.id}\n`));
}

export async function runHistory(
  agentConfigPath: string,
  opts: { limit: string; clear?: boolean; force?: boolean },
): Promise<void> {
  const config = loadOfflineConfig();
  const agent = await loadAgentConfig(agentConfigPath);
  const store = new FileMemoryStore(config.dataDir, agent.id);

  if (opts.clear) {
    if (!opts.force) {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const answer = (await rl.question(`Clear conversation history for ${agent.id}? [y/N] `)).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          stdout.write("Aborted.\n");
          return;
        }
      } finally {
        rl.close();
      }
    }
    await store.clearHistory();
    stdout.write(`History cleared for ${agent.id} (memories kept).\n`);
    return;
  }

  const messages = await store.loadHistory();
  if (messages.length === 0) {
    stdout.write("No history yet.\n");
    return;
  }
  const recent = messages.slice(-Number(opts.limit));
  for (const msg of recent) {
    stdout.write(`${renderHistoryMessage(msg)}\n`);
  }
  stdout.write(dim(`\n${recent.length} of ${messages.length} messages · agent ${agent.id}\n`));
}

function renderHistoryMessage(msg: Anthropic.MessageParam): string {
  const tag = msg.role === "user" ? cyan("user ›") : bold("agent ›");
  if (typeof msg.content === "string") return `${tag} ${truncate(msg.content, 500)}`;
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text") parts.push(truncate(block.text, 500));
    else if (block.type === "tool_use") parts.push(dim(`⚙ ${block.name}(${truncate(JSON.stringify(block.input), 120)})`));
    else if (block.type === "tool_result") {
      const body = typeof block.content === "string" ? block.content : "[blocks]";
      parts.push(dim(`↳ ${block.is_error ? "error: " : ""}${truncate(body, 200)}`));
    }
  }
  return `${tag} ${parts.filter(Boolean).join("\n  ")}`;
}

export async function runCosts(opts: { agent?: string }): Promise<void> {
  const config = loadOfflineConfig();
  let agentIds: string[];
  try {
    agentIds = (await readdir(join(config.dataDir, "agents"), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    stdout.write("No agent data yet.\n");
    return;
  }
  if (opts.agent) agentIds = agentIds.filter((id) => id === opts.agent);
  if (agentIds.length === 0) {
    stdout.write("No matching agents.\n");
    return;
  }

  const rows: string[][] = [[bold("agent"), bold("runs"), bold("in"), bold("out"), bold("cached"), bold("est. cost")]];
  let grandTotal = 0;
  let anyCost = false;

  for (const agentId of agentIds.sort()) {
    const records = await new RunLog(config.dataDir, agentId).readAll();
    if (records.length === 0) continue;
    let usage = emptyUsage();
    let cost = 0;
    let hasCost = false;
    for (const record of records) {
      usage = addTotals(usage, record.usage);
      const recordCost = record.costUsd ?? estimateCostUsd(record.model, record.usage);
      if (recordCost !== null) {
        cost += recordCost;
        hasCost = true;
      }
    }
    if (hasCost) {
      grandTotal += cost;
      anyCost = true;
    }
    rows.push([
      agentId,
      String(records.length),
      formatTokens(usage.inputTokens),
      formatTokens(usage.outputTokens),
      formatTokens(usage.cacheReadTokens),
      hasCost ? formatUsd(cost) : "n/a",
    ]);
  }

  if (rows.length === 1) {
    stdout.write("No runs recorded yet.\n");
    return;
  }
  stdout.write(`${table(rows)}\n`);
  if (anyCost) stdout.write(`\n${bold("total")} ${formatUsd(grandTotal)}\n`);
  stdout.write(dim("Estimates from public per-token prices; cache reads billed at ~0.1x input.\n"));
}

export function runConnectors(): void {
  const statuses = connectorStatuses();
  for (const status of statuses) {
    stdout.write(`${status.configured ? ok(bold(status.id)) : fail(bold(status.id))}  ${dim(status.description)}\n`);
    for (const key of status.envKeys) {
      const mark = key.set ? ok(key.env) : key.required ? fail(key.env) : warn(key.env);
      stdout.write(`    ${mark}${key.required ? "" : dim(" (optional)")}${key.note ? dim(` — ${key.note}`) : ""}\n`);
    }
  }
  stdout.write(dim("\nA connector is usable when all its required vars are set.\n"));
}

export async function runDoctor(opts: { probe?: boolean } = {}): Promise<void> {
  const probeEnabled = opts.probe ?? true;
  const stage = new Stage();
  let failed = false;

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) stage.print(`${ok(`node ${process.versions.node}`)}\n`);
  else {
    stage.print(`${fail(`node ${process.versions.node} — Exempclaw needs >= 22 (built-in WebSocket)`)}\n`);
    failed = true;
  }

  const config = loadOfflineConfig();
  stage.print(`${ok(`data dir: ${config.dataDir}`)}\n`);
  stage.print(`${ok(`default model: ${config.defaultModel} · action policy: ${config.actionPolicy}`)}\n`);

  // Anthropic API + connector probes run in parallel, each as a live row.
  const checks: Promise<void>[] = [];

  if (!config.anthropicApiKey) {
    stage.print(`${fail("ANTHROPIC_API_KEY is not set — agents cannot run (see .env.example)")}\n`);
    failed = true;
  } else {
    stage.addRow("api", { anim: "thinking", icon: "◈", label: "Anthropic API" });
    const claude = new ClaudeClient(config.anthropicApiKey, config.defaultModel, createLogger("error"));
    checks.push(
      claude.ping().then(
        (model) => stage.settleRow("api", { suffix: dim(`${model.displayName} (${model.id})`) }),
        (err) => {
          failed = true;
          stage.settleRow("api", { mark: "✗", color: "red", suffix: dim((err as Error).message) });
        },
      ),
    );
  }

  for (const status of connectorStatuses()) {
    if (!status.configured) {
      const missing = status.envKeys.filter((k) => k.required && !k.set).map((k) => k.env);
      stage.print(`${warn(`connector ${status.id}: not configured (missing ${missing.join(", ")})`)}\n`);
      continue;
    }
    if (!probeEnabled) {
      stage.print(`${ok(`connector ${status.id}: credentials present (probe skipped)`)}\n`);
      continue;
    }
    const prober = PROBES[status.id];
    if (!prober) continue;
    const rowId = `probe:${status.id}`;
    stage.addRow(rowId, { anim: "searching", icon: toolIcon(`${status.id}_`), label: `probing ${status.id}` });
    const { config: connectorConfig } = createConnector(status.id);
    checks.push(
      prober(connectorConfig).then((result) => {
        if (result.ok) {
          stage.settleRow(rowId, { label: `connector ${status.id}`, suffix: dim(result.detail) });
        } else {
          failed = true;
          stage.settleRow(rowId, {
            mark: "✗",
            color: "red",
            label: `connector ${status.id}`,
            suffix: dim(result.detail),
          });
        }
      }),
    );
  }

  await Promise.all(checks);
  stage.stopAll();
  if (failed) process.exitCode = 1;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
