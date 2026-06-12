import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFleetSnapshot, type AgentMeta } from "./data.js";
import { startDashboard } from "./server.js";
import { RunLog } from "../core/run-log.js";
import { FileMemoryStore } from "../memory/file-store.js";
import { PersonaSchema } from "../agent/persona.js";
import { quietLogger } from "../testing/factories.js";

async function seededDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "exempclaw-dash-"));
  const store = new FileMemoryStore(dir, "jordan");
  await store.addMemory({ text: "VIP customer is Initech", source: "onboarding", tags: ["initech"] });
  const log = new RunLog(dir, "jordan");
  await log.append({
    runId: "r1",
    agentId: "jordan",
    trigger: { kind: "event", detail: "email.received <m1>" },
    startedAt: "2026-06-12T10:00:00Z",
    finishedAt: "2026-06-12T10:00:30Z",
    model: "claude-opus-4-8",
    iterations: 3,
    stopReason: "end_turn",
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 100, turns: 3 },
    costUsd: null,
    outwardActions: [
      { tool: "email_send", approved: true, summary: '{"to":["ana@client.com"]}', at: "2026-06-12T10:00:20Z" },
      { tool: "slack_post_message", approved: false, summary: "{}", at: "2026-06-12T10:00:25Z" },
    ],
  });
  return dir;
}

const metas = new Map<string, AgentMeta>([
  [
    "jordan",
    {
      persona: PersonaSchema.parse({ name: "Jordan", role: "Support Lead", succeeds: "Alex", disclosure: "transparent" }),
      model: "claude-opus-4-8",
      connectors: ["email", "slack"],
    },
  ],
]);

test("buildFleetSnapshot aggregates runs, outward actions, costs, and memory", async () => {
  const dir = await seededDataDir();
  const snapshot = await buildFleetSnapshot(dir, metas);
  assert.equal(snapshot.agents.length, 1);
  const agent = snapshot.agents[0]!;
  assert.equal(agent.id, "jordan");
  assert.equal(agent.persona?.name, "Jordan");
  assert.equal(agent.persona?.succeeds, "Alex");
  assert.equal(agent.memoryCount, 1);
  assert.equal(agent.runs.total, 1);
  assert.equal(agent.runs.recent[0]!.tokens, 6300);
  assert.equal(agent.runs.recent[0]!.trigger, "event · email.received <m1>");
  assert.deepEqual(agent.outward, { total: 2, denied: 1 });
  assert.ok(agent.costUsd! > 0); // estimated from model pricing when record cost is null
  assert.deepEqual(agent.connectors, ["email", "slack"]);
});

test("configured-but-never-run agents still appear in the snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exempclaw-dash-"));
  const snapshot = await buildFleetSnapshot(dir, metas);
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.agents[0]!.runs.total, 0);
  assert.equal(snapshot.agents[0]!.memoryCount, 0);
});

test("dashboard serves the page and the fleet API on localhost", async () => {
  const dir = await seededDataDir();
  const { server, url } = await startDashboard({ dataDir: dir, port: 0, metas, log: quietLogger() });
  try {
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.match(html, /Succession/);
    assert.match(html, /api\/fleet/);

    const api = await fetch(`${url}/api/fleet`);
    assert.equal(api.status, 200);
    const fleet = (await api.json()) as { agents: Array<{ id: string }> };
    assert.equal(fleet.agents[0]!.id, "jordan");

    const missing = await fetch(`${url}/nope`);
    assert.equal(missing.status, 404);

    const post = await fetch(`${url}/api/fleet`, { method: "POST" });
    assert.equal(post.status, 405);
  } finally {
    server.close();
  }
});
