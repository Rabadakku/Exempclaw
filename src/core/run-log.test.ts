import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLog, type RunRecord } from "./run-log.js";
import { emptyUsage } from "./usage.js";

const record = (runId: string): RunRecord => ({
  runId,
  agentId: "a1",
  trigger: { kind: "cli" },
  startedAt: "2026-06-12T00:00:00Z",
  finishedAt: "2026-06-12T00:00:01Z",
  model: "claude-opus-4-8",
  iterations: 1,
  stopReason: "end_turn",
  usage: emptyUsage(),
  costUsd: 0.01,
  outwardActions: [],
});

test("run log round-trips records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exempclaw-"));
  const log = new RunLog(dir, "a1");
  await log.append(record("r1"));
  await log.append(record("r2"));
  const all = await log.readAll();
  assert.deepEqual(all.map((r) => r.runId), ["r1", "r2"]);
});

test("run log skips corrupt lines and missing files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exempclaw-"));
  const log = new RunLog(dir, "a1");
  assert.deepEqual(await log.readAll(), []);
  await log.append(record("good"));
  await appendFile(join(dir, "agents", "a1", "runs.jsonl"), "{torn-write\n", "utf8");
  await log.append(record("after"));
  const all = await log.readAll();
  assert.deepEqual(all.map((r) => r.runId), ["good", "after"]);
});
