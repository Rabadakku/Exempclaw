import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLog } from "../core/run-log.js";
import { loadFleetStats } from "./dashboard-data.js";

const NOW = Date.parse("2026-06-13T12:00:00Z");

function record(agentId: string, runId: string, startedAt: string, costUsd: number) {
  return {
    runId,
    agentId,
    trigger: { kind: "chat" as const },
    startedAt,
    finishedAt: startedAt,
    model: "m",
    iterations: 1,
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1 },
    costUsd,
    outwardActions: [],
  };
}

test("aggregates totals, today, per-day, per-agent and recent", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "exemp-dash-"));
  try {
    await new RunLog(dataDir, "sam").append(record("sam", "1", "2026-06-13T09:00:00Z", 0.5)); // today
    await new RunLog(dataDir, "sam").append(record("sam", "2", "2026-06-12T09:00:00Z", 0.25)); // yesterday
    await new RunLog(dataDir, "jordan").append(record("jordan", "3", "2026-06-13T10:00:00Z", 1.0)); // today

    const stats = await loadFleetStats(dataDir, NOW);
    assert.equal(stats.totalRuns, 3);
    assert.equal(Number(stats.totalSpendUsd.toFixed(2)), 1.75);
    assert.equal(Number(stats.spendTodayUsd.toFixed(2)), 1.5); // sam .5 + jordan 1.0
    assert.equal(stats.runsPerDay.length, 7);
    assert.equal(stats.runsPerDay[6], 2); // today
    assert.equal(stats.runsPerDay[5], 1); // yesterday
    // jordan spent more, so it sorts first
    assert.equal(stats.spendByAgent[0]!.id, "jordan");
    assert.equal(stats.spendByAgent[1]!.id, "sam");
    assert.equal(stats.spendByAgent[1]!.runs, 2);
    // recent is newest-first
    assert.equal(stats.recent[0]!.startedAt, "2026-06-13T10:00:00Z");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("empty data dir yields all-zero stats", async () => {
  const stats = await loadFleetStats(join(tmpdir(), "exemp-missing-dash-xyz"), NOW);
  assert.deepEqual(stats, {
    totalRuns: 0,
    totalSpendUsd: 0,
    spendTodayUsd: 0,
    runsPerDay: [0, 0, 0, 0, 0, 0, 0],
    spendByAgent: [],
    recent: [],
  });
});
