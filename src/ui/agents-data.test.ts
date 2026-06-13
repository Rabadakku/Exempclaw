import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLog } from "../core/run-log.js";
import { agentActivity } from "./agents-data.js";

test("agentActivity summarizes last run and total spend", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "exemp-data-"));
  try {
    const log = new RunLog(dataDir, "sam");
    const base = {
      agentId: "sam",
      trigger: { kind: "cli" as const },
      model: "m",
      iterations: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1 },
      outwardActions: [],
    };
    await log.append({ ...base, runId: "1", startedAt: "2026-06-01T00:00:00Z", finishedAt: "2026-06-01T00:00:05Z", costUsd: 0.5 });
    await log.append({ ...base, runId: "2", startedAt: "2026-06-02T00:00:00Z", finishedAt: "2026-06-02T00:00:05Z", costUsd: 0.25 });

    const activity = await agentActivity(dataDir, "sam");
    assert.equal(activity.runs, 2);
    assert.equal(activity.lastRunAt, "2026-06-02T00:00:00Z");
    assert.equal(activity.totalCostUsd, 0.75);

    const empty = await agentActivity(dataDir, "nobody");
    assert.deepEqual(empty, { runs: 0, lastRunAt: undefined, totalCostUsd: 0 });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
