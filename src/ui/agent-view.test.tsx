// src/ui/agent-view.test.tsx
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { AgentScreen } from "./screens/agent.js";
import { ApprovalBridge, type Services } from "./services.js";

const tick = () => new Promise((r) => setTimeout(r, 50));

function servicesWith(dispatch: (input: string, hooks: any) => Promise<unknown>): Services {
  const approvals = new ApprovalBridge();
  const orchestrator = {
    dispatch: (_id: string, input: string, opts: any) => dispatch(input, opts.hooks),
  } as never;
  return {
    config: { defaultModel: "m", dataDir: "/tmp/x", logLevel: "error", actionPolicy: "ask", contextBudgetTokens: 200_000 },
    agentsDir: "/tmp/agents",
    plugins: { plugins: [], failures: [] },
    applied: { extraTools: [], failures: [] },
    approvals,
    listAgents: async () => ({ agents: [], broken: [] }),
    getOrchestrator: async () => orchestrator,
    shutdown: async () => undefined,
  };
}

test("chat streams text and tool lines", async () => {
  const services = servicesWith(async (_input, hooks) => {
    hooks.onToolStart("recall", {});
    hooks.onToolEnd("recall", true);
    hooks.onText("Hello from Sam.");
    return { text: "Hello from Sam.", usage: {}, iterations: 1, stopReason: "end_turn" };
  });
  const { lastFrame, stdin } = render(
    <AgentScreen services={services} agentId="sam" onNavigate={() => undefined} />,
  );
  await tick();
  stdin.write("hi");
  await tick();
  stdin.write("\r");
  await tick();
  assert.match(lastFrame()!, /you ▸ hi/);
  assert.match(lastFrame()!, /recall/);
  assert.match(lastFrame()!, /Hello from Sam\./);
});

test("approval dialog renders and resolves on y", async () => {
  const services = servicesWith(async () => new Promise(() => undefined)); // never settles
  const { lastFrame, stdin } = render(
    <AgentScreen services={services} agentId="sam" onNavigate={() => undefined} />,
  );
  await tick();
  await tick();
  const decision = services.approvals.approve({ tool: "email_send", summary: "Send email", detail: "body" });
  await tick();
  await tick();
  assert.match(lastFrame()!, /Approval required — email_send/);
  stdin.write("y");
  assert.equal(await decision, true);
});
