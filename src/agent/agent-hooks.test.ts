import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { Agent } from "./agent.js";
import { PersonaSchema } from "./persona.js";
import { defineTool, ToolRegistry } from "../tools/tool.js";
import type { AgentActivity } from "../tools/tool.js";
import type { ClaudeTurnParams } from "../llm/claude.js";
import { InMemoryStore, makeMessage, quietLogger, scriptedClaude, toolUseBlock } from "../testing/factories.js";

const persona = PersonaSchema.parse({ name: "Jordan", role: "Support Lead" });

function baseDeps(claude: ReturnType<typeof scriptedClaude>, registry = new ToolRegistry()) {
  return {
    claude,
    tools: registry,
    memory: new InMemoryStore(),
    log: quietLogger(),
    actionPolicy: "ask" as const,
    approve: async () => true,
  };
}

test("onTurnStart fires once per model turn with the iteration number", async () => {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: "echo",
      description: "x",
      schema: z.object({}),
      execute: async () => ({ content: "ok" }),
    }),
  );
  const claude = scriptedClaude([
    makeMessage({ content: [toolUseBlock("t1", "echo", {})], stopReason: "tool_use" }),
    makeMessage({ content: "done" }),
  ]);
  const agent = new Agent({ id: "a", persona, model: "claude-opus-4-8" }, baseDeps(claude, registry));
  const turns: number[] = [];
  await agent.run("go", { hooks: { onTurnStart: (i) => turns.push(i) } });
  assert.deepEqual(turns, [1, 2]);
});

test("a tool's ctx.emit status reaches hooks.onStatus", async () => {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: "phased_work",
      description: "x",
      schema: z.object({}),
      execute: async (_input, ctx) => {
        ctx.emit?.({ kind: "status", activity: "reading", message: "going through the thread" });
        return { content: "ok" };
      },
    }),
  );
  const claude = scriptedClaude([
    makeMessage({ content: [toolUseBlock("t1", "phased_work", {})], stopReason: "tool_use" }),
    makeMessage({ content: "done" }),
  ]);
  const agent = new Agent({ id: "a", persona, model: "claude-opus-4-8" }, baseDeps(claude, registry));
  const statuses: Array<[AgentActivity, string]> = [];
  await agent.run("go", { hooks: { onStatus: (activity, message) => statuses.push([activity, message]) } });
  assert.deepEqual(statuses, [["reading", "going through the thread"]]);
});

test("aborting mid-turn settles gracefully: history saved, run recorded, no throw", async () => {
  const controller = new AbortController();
  const records: Array<{ stopReason: string | null; error?: string }> = [];
  const runLog = {
    append: async (r: { stopReason: string | null; error?: string }) => void records.push(r),
    readAll: async () => [],
  };
  const memory = new InMemoryStore();
  const claude = {
    calls: [] as ClaudeTurnParams[],
    summarizeCalls: [] as string[],
    async turn(params: ClaudeTurnParams): Promise<Anthropic.Message> {
      this.calls.push(params);
      // Simulate the operator hitting Ctrl-C while the request streams.
      controller.abort();
      throw new Error("aborted by user");
    },
    async summarize() {
      return "S";
    },
  };
  const agent = new Agent(
    { id: "a", persona, model: "claude-opus-4-8" },
    { ...baseDeps(claude as never), memory, runLog: runLog as never },
  );
  const result = await agent.run("long task", { signal: controller.signal });
  assert.equal(result.stopReason, "interrupted");
  assert.equal(result.iterations, 0);
  assert.equal(memory.history.length, 1, "the user turn is preserved");
  assert.equal(records.length, 1);
  assert.equal(records[0]!.stopReason, "interrupted");
  assert.equal(records[0]!.error, undefined, "an interrupt is not an error");
});

test("a pre-aborted signal never calls Claude", async () => {
  const controller = new AbortController();
  controller.abort();
  const claude = scriptedClaude([makeMessage({ content: "never" })]);
  const agent = new Agent({ id: "a", persona, model: "claude-opus-4-8" }, baseDeps(claude));
  const result = await agent.run("go", { signal: controller.signal });
  assert.equal(claude.calls.length, 0);
  assert.equal(result.stopReason, "interrupted");
});

test("non-abort Claude failures still throw", async () => {
  const claude = {
    calls: [],
    summarizeCalls: [],
    turn: async () => {
      throw new Error("server exploded");
    },
    summarize: async () => "S",
  };
  const agent = new Agent({ id: "a", persona, model: "claude-opus-4-8" }, baseDeps(claude as never));
  await assert.rejects(() => agent.run("go"), /server exploded/);
});
