import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinTools } from "./builtin.js";
import type { AgentSignal, ToolContext } from "./tool.js";
import { InMemoryStore, quietLogger } from "../testing/factories.js";

function ctx(emit?: (signal: AgentSignal) => void): ToolContext {
  return {
    agentId: "a1",
    log: quietLogger(),
    signal: new AbortController().signal,
    requestApproval: async () => true,
    ...(emit ? { emit } : {}),
  };
}

test("builtins include memory, clock, and the status channel", () => {
  const names = builtinTools(new InMemoryStore()).map((t) => t.name);
  assert.deepEqual(names, ["remember", "recall", "current_time", "display_status"]);
});

test("remember/recall round-trip through the store", async () => {
  const store = new InMemoryStore();
  const tools = new Map(builtinTools(store).map((t) => [t.name, t]));
  await tools.get("remember")!.execute({ text: "Ana prefers email", source: "self", tags: ["ana"] }, ctx());
  const result = await tools.get("recall")!.execute({ query: "ana", limit: 10 }, ctx());
  assert.match(result.content, /Ana prefers email/);
});

test("display_status emits a status signal to the attached UI", async () => {
  const signals: AgentSignal[] = [];
  const tools = new Map(builtinTools(new InMemoryStore()).map((t) => [t.name, t]));
  const status = tools.get("display_status")!;
  assert.equal(status.outward, false, "status display must not require approval");

  const result = await status.execute(
    { activity: "searching", message: "combing the inbox" },
    ctx((s) => signals.push(s)),
  );
  assert.deepEqual(signals, [{ kind: "status", activity: "searching", message: "combing the inbox" }]);
  assert.match(result.content, /shown to the operator/i);
});

test("display_status without a UI degrades to a log line, not an error", async () => {
  const tools = new Map(builtinTools(new InMemoryStore()).map((t) => [t.name, t]));
  const result = await tools.get("display_status")!.execute(
    { activity: "celebrating", message: "shipped it" },
    ctx(),
  );
  assert.equal(result.isError, undefined);
});

test("display_status rejects unknown activities via schema", () => {
  const tools = new Map(builtinTools(new InMemoryStore()).map((t) => [t.name, t]));
  const parsed = tools.get("display_status")!.schema.safeParse({ activity: "dancing", message: "x" });
  assert.equal(parsed.success, false);
});
