import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, loadOfflineConfig } from "./index.js";
import { ConfigError } from "../core/errors.js";
import { AgentConfigSchema } from "../agent/config.js";

test("loadOfflineConfig applies defaults without a key", () => {
  const config = loadOfflineConfig({});
  assert.equal(config.anthropicApiKey, undefined);
  assert.equal(config.defaultModel, "claude-opus-4-8");
  assert.equal(config.dataDir, "./data");
  assert.equal(config.actionPolicy, "ask");
  assert.equal(config.contextBudgetTokens, 200_000);
});

test("loadConfig requires the API key and honors overrides", () => {
  assert.throws(() => loadConfig({}), ConfigError);
  const config = loadConfig({
    ANTHROPIC_API_KEY: "sk-test",
    EXEMPCLAW_MODEL: "claude-sonnet-4-6",
    EXEMPCLAW_ACTION_POLICY: "deny",
    EXEMPCLAW_CONTEXT_BUDGET_TOKENS: "50000",
  });
  assert.equal(config.anthropicApiKey, "sk-test");
  assert.equal(config.defaultModel, "claude-sonnet-4-6");
  assert.equal(config.actionPolicy, "deny");
  assert.equal(config.contextBudgetTokens, 50_000);
});

test("invalid enum values produce a readable ConfigError", () => {
  assert.throws(
    () => loadConfig({ ANTHROPIC_API_KEY: "k", EXEMPCLAW_ACTION_POLICY: "yolo" }),
    /EXEMPCLAW_ACTION_POLICY/,
  );
});

test("agent config schema validates schedules and tool policies", () => {
  const parsed = AgentConfigSchema.parse({
    id: "a1",
    persona: { name: "J", role: "R" },
    toolPolicies: { email_send: "ask", "*": "deny" },
    schedules: [
      { every: "15m", input: "triage" },
      { dailyAt: "09:00", input: "standup" },
    ],
  });
  assert.equal(parsed.schedules.length, 2);

  assert.throws(() => AgentConfigSchema.parse({ id: "a", persona: { name: "J", role: "R" }, schedules: [{ input: "x" }] }));
  assert.throws(() =>
    AgentConfigSchema.parse({
      id: "a",
      persona: { name: "J", role: "R" },
      schedules: [{ every: "15m", dailyAt: "09:00", input: "x" }],
    }),
  );
  assert.throws(() =>
    AgentConfigSchema.parse({ id: "a", persona: { name: "J", role: "R" }, schedules: [{ every: "soon", input: "x" }] }),
  );
});
