import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Orchestrator } from "./orchestrator.js";
import { SeenEvents } from "./seen-events.js";
import { AgentConfigSchema } from "../agent/config.js";
import type { RuntimeConfig } from "../config/index.js";
import { quietLogger } from "../testing/factories.js";
import type { InboundEvent } from "../connectors/connector.js";
import type { RunResult } from "../agent/agent.js";

async function tempConfig(): Promise<RuntimeConfig> {
  return {
    anthropicApiKey: "test-key",
    defaultModel: "claude-opus-4-8",
    dataDir: await mkdtemp(join(tmpdir(), "exempclaw-")),
    logLevel: "error",
    actionPolicy: "ask",
    contextBudgetTokens: 200_000,
  };
}

const agentCfg = AgentConfigSchema.parse({
  id: "a1",
  persona: { name: "Jordan", role: "Support Lead" },
});

/** Replaces the managed agent's run() so no API calls happen. */
function stubAgentRun(
  orchestrator: Orchestrator,
  agentId: string,
  impl: (input: string) => Promise<string>,
): string[] {
  const inputs: string[] = [];
  const managed = (orchestrator as unknown as { managed: Map<string, { agent: { run: unknown } }> }).managed.get(
    agentId,
  );
  if (!managed) throw new Error("agent not managed");
  managed.agent.run = async (input: string): Promise<RunResult> => {
    inputs.push(input);
    const text = await impl(input);
    return {
      runId: "r",
      text,
      iterations: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1 },
      costUsd: 0,
    };
  };
  return inputs;
}

test("dispatch serializes runs per agent", async () => {
  const orchestrator = new Orchestrator(await tempConfig(), quietLogger(), async () => true);
  await orchestrator.addAgent(agentCfg);

  const order: string[] = [];
  stubAgentRun(orchestrator, "a1", async (input) => {
    order.push(`start:${input}`);
    await delay(input === "one" ? 30 : 1);
    order.push(`end:${input}`);
    return input;
  });

  const [first, second] = await Promise.all([
    orchestrator.dispatch("a1", "one"),
    orchestrator.dispatch("a1", "two"),
  ]);
  assert.equal(first.text, "one");
  assert.equal(second.text, "two");
  assert.deepEqual(order, ["start:one", "end:one", "start:two", "end:two"]);
  await orchestrator.shutdown();
});

test("a failed run does not poison the queue", async () => {
  const orchestrator = new Orchestrator(await tempConfig(), quietLogger(), async () => true);
  await orchestrator.addAgent(agentCfg);
  let first = true;
  stubAgentRun(orchestrator, "a1", async () => {
    if (first) {
      first = false;
      throw new Error("boom");
    }
    return "fine";
  });
  await assert.rejects(() => orchestrator.dispatch("a1", "x"), /boom/);
  const result = await orchestrator.dispatch("a1", "y");
  assert.equal(result.text, "fine");
  await orchestrator.shutdown();
});

test("duplicate inbound events are dropped, fresh ones dispatched", async () => {
  const orchestrator = new Orchestrator(await tempConfig(), quietLogger(), async () => true);
  await orchestrator.addAgent(agentCfg);
  const inputs = stubAgentRun(orchestrator, "a1", async () => "ok");

  const event: InboundEvent = {
    connector: "slack",
    type: "slack.mention",
    eventId: "Ev123",
    threadId: "C1:1.0",
    summary: "Mention from U1",
    payload: {},
    receivedAt: new Date().toISOString(),
  };

  type WithHandle = { handleEvent(agentId: string, managed: unknown, event: InboundEvent): Promise<void> };
  const internals = orchestrator as unknown as WithHandle & { managed: Map<string, unknown> };
  const managed = internals.managed.get("a1");
  await internals.handleEvent("a1", managed, event);
  await internals.handleEvent("a1", managed, event); // duplicate
  await internals.handleEvent("a1", managed, { ...event, eventId: "Ev124" });

  assert.equal(inputs.length, 2);
  assert.match(inputs[0]!, /slack\.mention/);
  assert.match(inputs[0]!, /Mention from U1/);
  await orchestrator.shutdown();
});

test("dispatch to an unknown agent throws", async () => {
  const orchestrator = new Orchestrator(await tempConfig(), quietLogger(), async () => true);
  await assert.rejects(() => orchestrator.dispatch("ghost", "hi"), /no such agent/);
  await orchestrator.shutdown();
});

test("SeenEvents dedups, evicts at capacity, and persists across instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exempclaw-"));
  const seen = new SeenEvents(dir, "a1", 3);
  assert.equal(await seen.markSeen("e1"), true);
  assert.equal(await seen.markSeen("e1"), false);
  assert.equal(await seen.markSeen("e2"), true);
  assert.equal(await seen.markSeen("e3"), true);
  assert.equal(await seen.markSeen("e4"), true); // evicts e1
  assert.equal(await seen.markSeen("e1"), true); // e1 forgotten after eviction
  await seen.persist();

  const reloaded = new SeenEvents(dir, "a1", 3);
  assert.equal(await reloaded.markSeen("e4"), false); // remembered across restart
  assert.equal(await reloaded.markSeen("brand-new"), true);
});
