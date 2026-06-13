// src/ui/create-wizard.test.tsx
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateScreen } from "./screens/create.js";
import { ApprovalBridge, type Services } from "./services.js";

const tick = () => new Promise((r) => setTimeout(r, 20));

test("wizard walks through and writes the agent config", async () => {
  const agentsDir = await mkdtemp(join(tmpdir(), "exemp-wiz-"));
  try {
    const services: Services = {
      config: { defaultModel: "m", dataDir: "/tmp/x", logLevel: "error", actionPolicy: "ask", contextBudgetTokens: 200_000 },
      agentsDir,
      plugins: { plugins: [], failures: [] },
      applied: { extraTools: [], failures: [] },
      approvals: new ApprovalBridge(),
      listAgents: async () => ({ agents: [], broken: [] }),
      getOrchestrator: () => Promise.reject(new Error("unused")),
      shutdown: async () => undefined,
    };
    const { lastFrame, stdin } = render(<CreateScreen services={services} onNavigate={() => undefined} />);
    assert.match(lastFrame()!, /agent's name/);
    stdin.write("Sam Vega"); await tick(); stdin.write("\r"); await tick();   // name
    stdin.write("Sales rep"); await tick(); stdin.write("\r"); await tick();  // role
    stdin.write("\r"); await tick();                                          // succeeds: skip
    stdin.write("\r"); await tick();                                          // tone: default
    assert.match(lastFrame()!, /identify as an AI/);
    stdin.write("\r"); await tick();                                          // disclosure: transparent
    stdin.write("\r"); await tick();                                          // connectors: none
    stdin.write("\r"); await tick();                                          // ingest: skip
    assert.match(lastFrame()!, /Create this agent\?/);
    stdin.write("y"); await tick();
    assert.match(lastFrame()!, /✓ Created/);

    const written = JSON.parse(await readFile(join(agentsDir, "sam-vega.json"), "utf8"));
    assert.equal(written.persona.name, "Sam Vega");
    assert.equal(written.persona.disclosure, "transparent");
  } finally {
    await rm(agentsDir, { recursive: true, force: true });
  }
});
