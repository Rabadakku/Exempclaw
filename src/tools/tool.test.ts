import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineTool, evaluatePolicy, resolvePolicy, ToolRegistry } from "./tool.js";

const echo = defineTool({
  name: "echo",
  description: "Echoes input back.",
  schema: z.object({ text: z.string().describe("What to echo.") }),
  execute: async (input) => ({ content: input.text }),
});

test("registry rejects duplicate tool names", () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  assert.throws(() => registry.register(echo), /duplicate tool/);
});

test("toAnthropicTools renders zod schemas as JSON schema", () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  const tools = registry.toAnthropicTools();
  assert.equal(tools.length, 1);
  const tool = tools[0]!;
  assert.equal(tool.name, "echo");
  assert.equal(tool.input_schema.type, "object");
  const properties = tool.input_schema.properties as Record<string, { type?: string; description?: string }>;
  assert.equal(properties.text?.type, "string");
  assert.equal(properties.text?.description, "What to echo.");
});

test("evaluatePolicy: auto allows, deny blocks, ask defers", async () => {
  const request = { tool: "t", summary: "s", detail: "d" };
  assert.equal(await evaluatePolicy("auto", request, async () => false), true);
  assert.equal(await evaluatePolicy("deny", request, async () => true), false);
  assert.equal(await evaluatePolicy("ask", request, async () => true), true);
  assert.equal(await evaluatePolicy("ask", request, async () => false), false);
});

test("resolvePolicy: exact override beats star beats global", () => {
  assert.equal(resolvePolicy("ask", undefined, "email_send"), "ask");
  assert.equal(resolvePolicy("ask", { "*": "deny" }, "email_send"), "deny");
  assert.equal(resolvePolicy("ask", { "*": "deny", email_send: "auto" }, "email_send"), "auto");
  assert.equal(resolvePolicy("deny", { slack_post_message: "auto" }, "email_send"), "deny");
});
