import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { definePlugin, pluginApi } from "./define.js";
import { defineTool } from "../tools/tool.js";

const helloTool = defineTool({
  name: "hello",
  description: "says hello",
  schema: z.object({ who: z.string() }),
  execute: async ({ who }) => ({ content: `hi ${who}` }),
});

test("definePlugin returns the spec", () => {
  const spec = definePlugin({ name: "demo-plugin", tools: [helloTool] });
  assert.equal(spec.name, "demo-plugin");
  assert.equal(spec.tools?.length, 1);
});

test("definePlugin rejects empty names", () => {
  assert.throws(() => definePlugin({ name: "" }), /plugin name/);
});

test("definePlugin rejects duplicate tool names", () => {
  assert.throws(() => definePlugin({ name: "p", tools: [helloTool, helloTool] }), /duplicate tool/);
});

test("pluginApi exposes z, defineTool and definePlugin", () => {
  assert.equal(typeof pluginApi.defineTool, "function");
  assert.equal(typeof pluginApi.definePlugin, "function");
  assert.equal(typeof pluginApi.z.object, "function");
});

test("definePlugin rejects a connector with no id", () => {
  assert.throws(
    () => definePlugin({ name: "p", connectors: [{ id: "", description: "d", envKeys: [], make: () => ({} as never) }] }),
    /invalid connector/,
  );
});

test("definePlugin rejects a connector with non-function make", () => {
  assert.throws(
    () => definePlugin({ name: "p", connectors: [{ id: "c1", description: "d", envKeys: [], make: "not-a-function" as never }] }),
    /invalid connector/,
  );
});

test("definePlugin rejects duplicate connector ids", () => {
  const make = () => ({}) as never;
  assert.throws(
    () => definePlugin({ name: "p", connectors: [
      { id: "c1", description: "d", envKeys: [], make },
      { id: "c1", description: "d", envKeys: [], make },
    ] }),
    /duplicate connector/,
  );
});
