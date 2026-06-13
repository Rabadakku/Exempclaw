import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldPlugin } from "./scaffold.js";
import { loadPlugins } from "./loader.js";

test("scaffolded plugin loads successfully", async () => {
  const root = await mkdtemp(join(tmpdir(), "exemp-scaffold-"));
  try {
    const dir = await scaffoldPlugin(root, "weather");
    assert.equal(dir, join(root, "weather"));
    const manifest = JSON.parse(await readFile(join(dir, "exempclaw.plugin.json"), "utf8"));
    assert.equal(manifest.name, "weather");

    const result = await loadPlugins(root);
    assert.equal(result.failures.length, 0);
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.spec.tools?.[0]?.name, "weather_hello");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scaffold refuses to overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "exemp-scaffold-"));
  try {
    await scaffoldPlugin(root, "dup");
    await assert.rejects(scaffoldPlugin(root, "dup"), /already exists/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scaffold validates the name", async () => {
  await assert.rejects(scaffoldPlugin("/tmp", "Bad Name!"), /lowercase/);
});
