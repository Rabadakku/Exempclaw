// src/ui/app.test.tsx
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "./app.js";
import { ApprovalBridge, type Services } from "./services.js";

function stubServices(): Services {
  return {
    config: {
      defaultModel: "claude-opus-4-8",
      dataDir: "/tmp/exemp-test-data",
      logLevel: "error",
      actionPolicy: "ask",
      contextBudgetTokens: 200_000,
    },
    agentsDir: "/tmp/exemp-test-agents",
    plugins: { plugins: [], failures: [] },
    applied: { extraTools: [], failures: [] },
    approvals: new ApprovalBridge(),
    listAgents: async () => ({ agents: [], broken: [] }),
    getOrchestrator: () => Promise.reject(new Error("no orchestrator in this test")),
    shutdown: async () => undefined,
  };
}

const sam = {
  path: "/tmp/sam.json",
  config: { id: "sam", persona: { name: "Sam", role: "Sales" }, connectors: [], schedules: [] },
};

test("home menu renders and navigates", async () => {
  const { lastFrame, stdin } = render(
    <App services={stubServices()} initialAgents={[sam as never]} initialBroken={[]} />,
  );
  assert.match(lastFrame()!, /E X E M P C L A W/);
  assert.match(lastFrame()!, /Agents/);
  assert.match(lastFrame()!, /1 configured/);
  // Move cursor down to "New agent" then select it.
  // Each write is synchronous but React needs a tick to commit the state update.
  stdin.write("\x1B[B"); // down arrow
  await new Promise((r) => setImmediate(r));
  stdin.write("\r"); // enter
  await new Promise((r) => setImmediate(r));
  assert.match(lastFrame()!, /create/);
});

test("zero agents starts on the create wizard", () => {
  const { lastFrame } = render(<App services={stubServices()} initialAgents={[]} initialBroken={[]} />);
  assert.match(lastFrame()!, /create/);
});
