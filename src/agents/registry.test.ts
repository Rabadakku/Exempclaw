import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentsDir, listAgents, saveAgent } from "./registry.js";

const VALID = {
  id: "sam",
  persona: { name: "Sam", role: "Sales rep" },
  connectors: [],
  schedules: [],
};

test("resolveAgentsDir: env override wins, then ./agents, then home", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "exemp-cwd-"));
  try {
    assert.equal(resolveAgentsDir({ EXEMPCLAW_AGENTS_DIR: "/x/y" }, cwd), "/x/y");
    const fallback = resolveAgentsDir({}, cwd);
    assert.ok(fallback.endsWith(join(".exempclaw", "agents")), fallback);
    await mkdir(join(cwd, "agents"));
    assert.equal(resolveAgentsDir({}, cwd), join(cwd, "agents"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("listAgents returns valid configs and reports broken ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exemp-agents-"));
  try {
    await writeFile(join(dir, "sam.json"), JSON.stringify(VALID), "utf8");
    await writeFile(join(dir, "broken.json"), "{not json", "utf8");
    await writeFile(join(dir, "notes.txt"), "ignored", "utf8");
    const { agents, broken } = await listAgents(dir);
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.config.id, "sam");
    assert.equal(broken.length, 1);
    assert.ok(broken[0]!.path.endsWith("broken.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listAgents on a missing dir is empty, saveAgent creates and refuses overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "exemp-save-"));
  const dir = join(root, "nested", "agents");
  try {
    assert.deepEqual(await listAgents(dir), { agents: [], broken: [] });
    const path = await saveAgent(dir, VALID);
    assert.equal(path, join(dir, "sam.json"));
    const { agents } = await listAgents(dir);
    assert.equal(agents.length, 1);
    await assert.rejects(saveAgent(dir, VALID), /already exists/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
