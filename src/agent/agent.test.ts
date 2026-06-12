import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { Agent, type AgentDeps, type AgentOptions } from "./agent.js";
import { PersonaSchema } from "./persona.js";
import { defineTool, ToolRegistry } from "../tools/tool.js";
import type { ApprovalRequest } from "../tools/tool.js";
import {
  InMemoryStore,
  makeMessage,
  quietLogger,
  scriptedClaude,
  toolUseBlock,
  type ScriptedClaude,
} from "../testing/factories.js";

const persona = PersonaSchema.parse({ name: "Jordan", role: "Support Lead" });

interface Harness {
  agent: Agent;
  claude: ScriptedClaude;
  memory: InMemoryStore;
  approvals: ApprovalRequest[];
}

function makeAgent(
  script: Anthropic.Message[],
  opts: {
    tools?: ReturnType<typeof defineTool>[];
    approve?: boolean;
    options?: Partial<AgentOptions>;
    deps?: Partial<AgentDeps>;
  } = {},
): Harness {
  const claude = scriptedClaude(script);
  const memory = new InMemoryStore();
  const registry = new ToolRegistry();
  for (const tool of opts.tools ?? []) registry.register(tool);
  const approvals: ApprovalRequest[] = [];

  const agent = new Agent(
    {
      id: "agent-1",
      persona,
      model: "claude-opus-4-8",
      ...opts.options,
    },
    {
      claude,
      tools: registry,
      memory,
      log: quietLogger(),
      actionPolicy: "ask",
      approve: async (req) => {
        approvals.push(req);
        return opts.approve ?? true;
      },
      ...opts.deps,
    },
  );
  return { agent, claude, memory, approvals };
}

const echoTool = defineTool({
  name: "echo",
  description: "Echo.",
  schema: z.object({ text: z.string() }),
  execute: async (input) => ({ content: `echo:${input.text}` }),
});

const sendTool = defineTool({
  name: "send_thing",
  description: "Sends a thing.",
  outward: true,
  schema: z.object({ to: z.string() }),
  execute: async (input) => ({ content: `sent to ${input.to}` }),
});

function lastToolResults(memory: InMemoryStore): Anthropic.ToolResultBlockParam[] {
  for (let i = memory.history.length - 1; i >= 0; i--) {
    const msg = memory.history[i]!;
    if (msg.role === "user" && Array.isArray(msg.content) && msg.content.some((b) => b.type === "tool_result")) {
      return msg.content.filter((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result");
    }
  }
  return [];
}

test("plain text response: one iteration, history persisted, usage counted", async () => {
  const { agent, memory } = makeAgent([makeMessage({ content: "hello there", inputTokens: 11, outputTokens: 7 })]);
  const result = await agent.run("hi");
  assert.equal(result.text, "hello there");
  assert.equal(result.iterations, 1);
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1 });
  assert.ok(result.costUsd! > 0);
  assert.equal(memory.history.length, 2);
  assert.equal(memory.history[0]!.content, "hi");
});

test("tool loop: executes the call, feeds back the result, settles", async () => {
  const { agent, memory, claude } = makeAgent(
    [
      makeMessage({ content: [toolUseBlock("t1", "echo", { text: "ping" })], stopReason: "tool_use" }),
      makeMessage({ content: "done" }),
    ],
    { tools: [echoTool] },
  );
  const result = await agent.run("go");
  assert.equal(result.iterations, 2);
  assert.equal(result.text, "done");
  const results = lastToolResults(memory);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.tool_use_id, "t1");
  assert.equal(results[0]!.content, "echo:ping");
  assert.equal(results[0]!.is_error, undefined);
  // second call must include the tool result in the conversation
  assert.equal(claude.calls.length, 2);
  assert.equal(claude.calls[1]!.messages.length, 3);
});

test("multiple read-only calls in one turn run and keep call order", async () => {
  const { agent, memory } = makeAgent(
    [
      makeMessage({
        content: [toolUseBlock("a", "echo", { text: "one" }), toolUseBlock("b", "echo", { text: "two" })],
        stopReason: "tool_use",
      }),
      makeMessage({ content: "ok" }),
    ],
    { tools: [echoTool] },
  );
  await agent.run("go");
  const results = lastToolResults(memory);
  assert.deepEqual(results.map((r) => r.tool_use_id), ["a", "b"]);
  assert.deepEqual(results.map((r) => r.content), ["echo:one", "echo:two"]);
});

test("outward tool: denial comes back as is_error and is audited", async () => {
  const { agent, memory, approvals } = makeAgent(
    [
      makeMessage({ content: [toolUseBlock("t1", "send_thing", { to: "jane" })], stopReason: "tool_use" }),
      makeMessage({ content: "understood" }),
    ],
    { tools: [sendTool], approve: false },
  );
  const result = await agent.run("send it");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.tool, "send_thing");
  const results = lastToolResults(memory);
  assert.equal(results[0]!.is_error, true);
  assert.match(String(results[0]!.content), /denied/);
  assert.equal(result.text, "understood");
});

test("outward tool: approval executes it", async () => {
  const { agent, memory, approvals } = makeAgent(
    [
      makeMessage({ content: [toolUseBlock("t1", "send_thing", { to: "jane" })], stopReason: "tool_use" }),
      makeMessage({ content: "sent" }),
    ],
    { tools: [sendTool], approve: true },
  );
  await agent.run("send it");
  assert.equal(approvals.length, 1);
  assert.equal(lastToolResults(memory)[0]!.content, "sent to jane");
});

test("per-tool policy override: auto skips the approver entirely", async () => {
  const { agent, memory, approvals } = makeAgent(
    [
      makeMessage({ content: [toolUseBlock("t1", "send_thing", { to: "jane" })], stopReason: "tool_use" }),
      makeMessage({ content: "sent" }),
    ],
    { tools: [sendTool], approve: false, options: { toolPolicies: { send_thing: "auto" } } },
  );
  await agent.run("send it");
  assert.equal(approvals.length, 0);
  assert.equal(lastToolResults(memory)[0]!.content, "sent to jane");
});

test("unknown tool and invalid input come back as tool errors", async () => {
  const { agent, memory } = makeAgent(
    [
      makeMessage({
        content: [toolUseBlock("u1", "nope", {}), toolUseBlock("u2", "echo", { text: 42 })],
        stopReason: "tool_use",
      }),
      makeMessage({ content: "ok" }),
    ],
    { tools: [echoTool] },
  );
  await agent.run("go");
  const results = lastToolResults(memory);
  assert.equal(results.length, 2);
  assert.match(String(results[0]!.content), /unknown tool/);
  assert.equal(results[0]!.is_error, true);
  assert.match(String(results[1]!.content), /invalid input/);
  assert.equal(results[1]!.is_error, true);
});

test("a throwing tool is reported, not fatal", async () => {
  const bomb = defineTool({
    name: "bomb",
    description: "Throws.",
    schema: z.object({}),
    execute: async () => {
      throw new Error("kaboom");
    },
  });
  const { agent, memory } = makeAgent(
    [
      makeMessage({ content: [toolUseBlock("t1", "bomb", {})], stopReason: "tool_use" }),
      makeMessage({ content: "recovered" }),
    ],
    { tools: [bomb] },
  );
  const result = await agent.run("go");
  assert.equal(result.text, "recovered");
  assert.match(String(lastToolResults(memory)[0]!.content), /kaboom/);
});

test("maxIterations bounds a runaway loop", async () => {
  const { agent, claude } = makeAgent(
    [makeMessage({ content: [toolUseBlock("t", "echo", { text: "again" })], stopReason: "tool_use" })],
    { tools: [echoTool], options: { maxIterations: 3 } },
  );
  const result = await agent.run("go");
  assert.equal(result.iterations, 3);
  assert.equal(claude.calls.length, 3);
});

test("pause_turn re-sends without executing tools", async () => {
  const { agent, claude } = makeAgent([
    makeMessage({ content: "working…", stopReason: "pause_turn" }),
    makeMessage({ content: "finished" }),
  ]);
  const result = await agent.run("go");
  assert.equal(result.iterations, 2);
  assert.equal(result.text, "finished");
  assert.equal(claude.calls.length, 2);
});

test("run records are appended with usage, trigger, and outward actions", async () => {
  const records: unknown[] = [];
  const runLog = { append: async (r: unknown) => void records.push(r), readAll: async () => [] };
  const { agent } = makeAgent(
    [
      makeMessage({ content: [toolUseBlock("t1", "send_thing", { to: "jane" })], stopReason: "tool_use" }),
      makeMessage({ content: "sent" }),
    ],
    { tools: [sendTool], approve: true, deps: { runLog: runLog as never } },
  );
  await agent.run("send it", { trigger: { kind: "event", detail: "email.received x" } });
  assert.equal(records.length, 1);
  const record = records[0] as {
    trigger: { kind: string };
    iterations: number;
    outwardActions: Array<{ tool: string; approved: boolean }>;
    usage: { turns: number };
    costUsd: number;
  };
  assert.equal(record.trigger.kind, "event");
  assert.equal(record.iterations, 2);
  assert.deepEqual(record.outwardActions.map((a) => [a.tool, a.approved]), [["send_thing", true]]);
  assert.equal(record.usage.turns, 2);
  assert.ok(record.costUsd > 0);
});

test("memories are injected into the system prompt's dynamic block", async () => {
  const { agent, claude, memory } = makeAgent([makeMessage({ content: "ok" })]);
  await memory.addMemory({ text: "the VIP customer is Initech", source: "onboarding", tags: [] });
  await agent.run("hi");
  const system = claude.calls[0]!.system;
  assert.equal(system.length, 2);
  assert.match(system[1]!.text, /Initech/);
  assert.deepEqual(system[0]!.cache_control, { type: "ephemeral" });
});

test("history past the context budget is compacted after the run", async () => {
  const { agent, memory, claude } = makeAgent(
    [makeMessage({ content: "answer", inputTokens: 999_999 })],
    { options: { contextBudgetTokens: 20_000 } },
  );
  for (let i = 0; i < 6; i++) {
    memory.history.push({ role: "user", content: `q${i}` });
    memory.history.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }] });
  }
  await agent.run("latest question");
  assert.equal(claude.summarizeCalls.length, 1);
  const first = memory.history[0]!;
  assert.ok(Array.isArray(first.content));
  assert.match((first.content as Anthropic.TextBlockParam[])[0]!.text, /<conversation_summary>/);
  // 14 messages → summary pair + last 8
  assert.equal(memory.history.length, 10);
});

test("under budget, history is saved verbatim with no summarize call", async () => {
  const { agent, memory, claude } = makeAgent([makeMessage({ content: "ok", inputTokens: 10 })]);
  await agent.run("hi");
  assert.equal(claude.summarizeCalls.length, 0);
  assert.equal(memory.history.length, 2);
});

test("a Claude failure still writes a run record with the error", async () => {
  const records: Array<{ error?: string }> = [];
  const runLog = { append: async (r: { error?: string }) => void records.push(r), readAll: async () => [] };
  const failing = {
    calls: [],
    summarizeCalls: [],
    turn: async () => {
      throw new Error("api exploded");
    },
    summarize: async () => "S",
  };
  const memory = new InMemoryStore();
  const agent = new Agent(
    { id: "a", persona, model: "claude-opus-4-8" },
    {
      claude: failing,
      tools: new ToolRegistry(),
      memory,
      log: quietLogger(),
      actionPolicy: "ask",
      approve: async () => true,
      runLog: runLog as never,
    },
  );
  await assert.rejects(() => agent.run("hi"), /api exploded/);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.error, "api exploded");
});
