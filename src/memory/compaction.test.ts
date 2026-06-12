import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { compactHistory, findCutIndex, renderTranscript } from "./compaction.js";

const user = (text: string): Anthropic.MessageParam => ({ role: "user", content: text });
const assistant = (text: string): Anthropic.MessageParam => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const toolCall = (id: string): Anthropic.MessageParam => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "lookup", input: { q: "x" } }],
});
const toolResult = (id: string): Anthropic.MessageParam => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "result" }],
});

test("short histories are returned unchanged (same reference)", async () => {
  const messages = [user("a"), assistant("b")];
  const out = await compactHistory(messages, { summarize: async () => "S" });
  assert.equal(out, messages);
});

test("findCutIndex skips tool_result boundaries", () => {
  // index:        0          1            2            3              4          5
  const messages = [user("q"), toolCall("t1"), toolResult("t1"), assistant("done"), user("next"), assistant("ok")];
  // target = 6 - 4 = 2 → messages[2] is a tool_result follow-up → slide to 4.
  assert.equal(findCutIndex(messages, 4), 4);
});

test("findCutIndex returns null when no valid boundary exists in the tail", () => {
  const messages = [user("q"), toolCall("t1"), toolResult("t1"), assistant("done")];
  assert.equal(findCutIndex(messages, 2), null);
});

test("compactHistory replaces the head with a summary exchange", async () => {
  const messages: Anthropic.MessageParam[] = [];
  for (let i = 0; i < 6; i++) {
    messages.push(user(`question ${i}`));
    messages.push(assistant(`answer ${i}`));
  }
  // 12 messages, keepRecent 4 → cut at index 8 (a plain user turn).
  const out = await compactHistory(messages, { keepRecent: 4, summarize: async () => "THE-SUMMARY" });
  assert.equal(out.length, 2 + 4);
  const first = out[0]!;
  assert.equal(first.role, "user");
  const text = (first.content as Anthropic.TextBlockParam[])[0]!.text;
  assert.match(text, /<conversation_summary>/);
  assert.match(text, /THE-SUMMARY/);
  assert.equal(out[1]!.role, "assistant");
  // tail kept verbatim
  assert.deepEqual(out.slice(2), messages.slice(8));
});

test("compaction never splits a tool_use from its tool_result", async () => {
  const messages: Anthropic.MessageParam[] = [user("start")];
  for (let i = 0; i < 5; i++) {
    messages.push(toolCall(`t${i}`));
    messages.push(toolResult(`t${i}`));
  }
  messages.push(assistant("done"), user("follow-up"), assistant("sure"));
  const out = await compactHistory(messages, { keepRecent: 6, summarize: async () => "S" });
  // The kept tail must not begin with a tool_result.
  const firstKept = out[2]!;
  const hasOrphanResult =
    Array.isArray(firstKept.content) && firstKept.content.some((b) => b.type === "tool_result");
  assert.equal(hasOrphanResult, false);
});

test("renderTranscript covers text, tool calls, and errors", () => {
  const transcript = renderTranscript([
    user("hello"),
    toolCall("t1"),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "oops", is_error: true }] },
    assistant("final"),
  ]);
  assert.match(transcript, /USER: hello/);
  assert.match(transcript, /called lookup/);
  assert.match(transcript, /TOOL RESULT \(error\): oops/);
  assert.match(transcript, /ASSISTANT: final/);
});
