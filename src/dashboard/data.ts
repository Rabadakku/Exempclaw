import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { RunLog, type RunRecord } from "../core/run-log.js";
import { addTotals, emptyUsage, estimateCostUsd, type UsageTotals } from "../core/usage.js";
import { FileMemoryStore } from "../memory/file-store.js";
import type { Persona } from "../agent/persona.js";

/**
 * Assembles the read-only fleet snapshot served to the dashboard. Everything
 * comes from the data dir (runs.jsonl, memory.json); agent configs passed on
 * the CLI enrich entries with persona details.
 */

export interface AgentMeta {
  persona: Persona;
  model?: string;
  connectors: string[];
}

export interface AgentSnapshot {
  id: string;
  persona?: {
    name: string;
    role: string;
    succeeds?: string;
    disclosure: string;
  };
  model?: string;
  connectors: string[];
  memoryCount: number;
  recentMemories: Array<{ text: string; source: string; tags: string[]; createdAt: string }>;
  runs: {
    total: number;
    lastAt?: string;
    recent: Array<{
      runId: string;
      trigger: string;
      startedAt: string;
      iterations: number;
      stopReason: string | null;
      tokens: number;
      costUsd: number | null;
      outward: Array<{ tool: string; approved: boolean; summary: string }>;
      error?: string;
    }>;
  };
  usage: UsageTotals;
  costUsd: number | null;
  outward: { total: number; denied: number };
}

export interface FleetSnapshot {
  generatedAt: string;
  dataDir: string;
  agents: AgentSnapshot[];
}

export async function buildFleetSnapshot(
  dataDir: string,
  metas: Map<string, AgentMeta> = new Map(),
): Promise<FleetSnapshot> {
  let ids: string[] = [];
  try {
    ids = (await readdir(join(dataDir, "agents"), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // no data yet
  }
  for (const id of metas.keys()) {
    if (!ids.includes(id)) ids.push(id); // configured but not yet run
  }

  const agents = await Promise.all(ids.sort().map((id) => buildAgentSnapshot(dataDir, id, metas.get(id))));
  return { generatedAt: new Date().toISOString(), dataDir, agents };
}

export async function buildAgentSnapshot(dataDir: string, id: string, meta?: AgentMeta): Promise<AgentSnapshot> {
  const store = new FileMemoryStore(dataDir, id);
  const memories = await store.allMemories().catch(() => []);
  const records = await new RunLog(dataDir, id).readAll().catch(() => [] as RunRecord[]);

  let usage = emptyUsage();
  let cost = 0;
  let hasCost = false;
  let outwardTotal = 0;
  let outwardDenied = 0;
  for (const record of records) {
    usage = addTotals(usage, record.usage);
    const recordCost = record.costUsd ?? estimateCostUsd(record.model, record.usage);
    if (recordCost !== null) {
      cost += recordCost;
      hasCost = true;
    }
    outwardTotal += record.outwardActions.length;
    outwardDenied += record.outwardActions.filter((a) => !a.approved).length;
  }

  const recent = records.slice(-30).reverse();
  return {
    id,
    ...(meta
      ? {
          persona: {
            name: meta.persona.name,
            role: meta.persona.role,
            ...(meta.persona.succeeds ? { succeeds: meta.persona.succeeds } : {}),
            disclosure: meta.persona.disclosure,
          },
          model: meta.model,
        }
      : {}),
    connectors: meta?.connectors ?? [],
    memoryCount: memories.length,
    recentMemories: memories.slice(-12).reverse().map((m) => ({
      text: m.text,
      source: m.source,
      tags: m.tags,
      createdAt: m.createdAt,
    })),
    runs: {
      total: records.length,
      ...(records.length > 0 ? { lastAt: records[records.length - 1]!.finishedAt } : {}),
      recent: recent.map((r) => ({
        runId: r.runId,
        trigger: r.trigger.detail ? `${r.trigger.kind} · ${r.trigger.detail}` : r.trigger.kind,
        startedAt: r.startedAt,
        iterations: r.iterations,
        stopReason: r.stopReason,
        tokens: r.usage.inputTokens + r.usage.outputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens,
        costUsd: r.costUsd ?? estimateCostUsd(r.model, r.usage),
        outward: r.outwardActions.map((a) => ({ tool: a.tool, approved: a.approved, summary: a.summary })),
        ...(r.error ? { error: r.error } : {}),
      })),
    },
    usage,
    costUsd: hasCost ? cost : null,
    outward: { total: outwardTotal, denied: outwardDenied },
  };
}
