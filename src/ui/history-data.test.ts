import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLog } from "../core/run-log.js";
import { loadFleetHistory } from "./history-data.js";

test("merges all agents' runs newest-first", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "exemp-hist-"));
  try {
    const base = {
      trigger: { kind: "cli" as const }, model: "m", iterations: 1, stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1 },
      costUsd: 0, outwardActions: [],
    };
    await new RunLog(dataDir, "a").append({ ...base, runId: "1", agentId: "a", startedAt: "2026-06-01T00:00:00Z", finishedAt: "2026-06-01T00:00:01Z" });
    await new RunLog(dataDir, "b").append({ ...base, runId: "2", agentId: "b", startedAt: "2026-06-02T00:00:00Z", finishedAt: "2026-06-02T00:00:01Z" });
    const history = await loadFleetHistory(dataDir);
    assert.deepEqual(history.map((r) => r.runId), ["2", "1"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("empty data dir yields empty history", async () => {
  assert.deepEqual(await loadFleetHistory(join(tmpdir(), "missing-xyz")), []);
});
