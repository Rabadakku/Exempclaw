import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { applyPlugins } from "./apply.js";
import { defineTool } from "../tools/tool.js";
import { availableConnectorIds, createConnector } from "../connectors/index.js";
import type { Connector } from "../connectors/connector.js";

function stubConnector(id: string): Connector {
  return { id, init: async () => undefined, tools: () => [] };
}

const tool = defineTool({
  name: "t1",
  description: "d",
  schema: z.object({}),
  execute: async () => ({ content: "ok" }),
});

test("applyPlugins registers connectors and collects tools", () => {
  const applied = applyPlugins({
    plugins: [
      {
        manifest: { name: "p1", version: "0.1.0", description: "", entry: "./index.js" },
        dir: "/tmp/p1",
        spec: {
          name: "p1",
          tools: [tool],
          connectors: [{ id: "p1-conn", description: "test", envKeys: [], make: () => stubConnector("p1-conn") }],
        },
      },
    ],
    failures: [],
  });
  assert.deepEqual(applied.extraTools.map((t) => t.name), ["t1"]);
  assert.equal(applied.failures.length, 0);
  assert.ok(availableConnectorIds().includes("p1-conn"));
  assert.equal(createConnector("p1-conn").connector.id, "p1-conn");
});

test("a connector id collision fails that plugin only", () => {
  const spec = {
    name: "clash",
    connectors: [{ id: "email", description: "clash", envKeys: [], make: () => stubConnector("email") }],
  };
  const applied = applyPlugins({
    plugins: [{ manifest: { name: "clash", version: "0.1.0", description: "", entry: "./index.js" }, dir: "/tmp/clash", spec }],
    failures: [],
  });
  assert.equal(applied.extraTools.length, 0);
  assert.equal(applied.failures.length, 1);
  assert.match(applied.failures[0]!.error, /already registered/);
});
