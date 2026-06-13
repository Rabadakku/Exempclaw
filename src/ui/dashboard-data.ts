import { loadFleetHistory } from "./history-data.js";
import type { RunRecord } from "../core/run-log.js";

export interface AgentSpend {
  id: string;
  spendUsd: number;
  runs: number;
}

export interface FleetStats {
  totalRuns: number;
  totalSpendUsd: number;
  spendTodayUsd: number;
  /** Run counts for the last 7 days, oldest → newest (index 6 = today). */
  runsPerDay: number[];
  /** Per-agent spend, highest first. */
  spendByAgent: AgentSpend[];
  /** Most recent runs across the whole fleet, newest first. */
  recent: RunRecord[];
}

const DAY_MS = 86_400_000;

/**
 * Rolls every agent's run log up into the numbers the dashboard renders:
 * totals, today's spend, a 7-day run histogram, per-agent spend, and a
 * recent-activity slice. Empty/missing data dir yields all-zero stats.
 */
export async function loadFleetStats(dataDir: string, now: number = Date.now()): Promise<FleetStats> {
  const runs = await loadFleetHistory(dataDir); // already newest-first
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  let totalSpendUsd = 0;
  let spendTodayUsd = 0;
  const byAgent = new Map<string, { spendUsd: number; runs: number }>();
  const runsPerDay = new Array<number>(7).fill(0);

  for (const record of runs) {
    const cost = record.costUsd ?? 0;
    totalSpendUsd += cost;

    const entry = byAgent.get(record.agentId) ?? { spendUsd: 0, runs: 0 };
    entry.spendUsd += cost;
    entry.runs += 1;
    byAgent.set(record.agentId, entry);

    const startedAt = Date.parse(record.startedAt);
    if (Number.isFinite(startedAt)) {
      if (startedAt >= startOfToday.getTime()) spendTodayUsd += cost;
      const ageDays = Math.floor((now - startedAt) / DAY_MS);
      if (ageDays >= 0 && ageDays < 7) runsPerDay[6 - ageDays]! += 1;
    }
  }

  const spendByAgent: AgentSpend[] = [...byAgent.entries()]
    .map(([id, v]) => ({ id, spendUsd: v.spendUsd, runs: v.runs }))
    .sort((a, b) => b.spendUsd - a.spendUsd || b.runs - a.runs);

  return {
    totalRuns: runs.length,
    totalSpendUsd,
    spendTodayUsd,
    runsPerDay,
    spendByAgent,
    recent: runs.slice(0, 6),
  };
}
