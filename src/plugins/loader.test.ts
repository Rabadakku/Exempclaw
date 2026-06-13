import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugins } from "./loader.js";

async function makePluginDir(root: string, name: string, files: Record<string, string>) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(dir, file), content, "utf8");
  }
  return dir;
}

test("loads a factory-form plugin and isolates broken ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "exemp-plugins-"));
  try {
    await makePluginDir(root, "good", {
      "exempclaw.plugin.json": JSON.stringify({ name: "good", version: "0.1.0", entry: "./index.mjs" }),
      "index.mjs": `export default function ({ z, defineTool, definePlugin }) {
        return definePlugin({ name: "good", tools: [defineTool({
          name: "good_hello", description: "d", schema: z.object({}),
          execute: async () => ({ content: "ok" }),
        })] });
      }`,
    });
    await makePluginDir(root, "no-manifest", { "index.mjs": "export default {}" });
    await makePluginDir(root, "bad-entry", {
      "exempclaw.plugin.json": JSON.stringify({ name: "bad-entry", version: "0.1.0", entry: "./index.mjs" }),
      "index.mjs": "this is not javascript {{{",
    });

    const result = await loadPlugins(root);
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.manifest.name, "good");
    assert.equal(result.plugins[0]!.spec.tools?.[0]?.name, "good_hello");
    assert.equal(result.failures.length, 2);
    const failedNames = result.failures.map((f) => f.name).sort();
    assert.deepEqual(failedNames, ["bad-entry", "no-manifest"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing plugins dir yields empty result", async () => {
  const result = await loadPlugins(join(tmpdir(), "definitely-missing-xyz"));
  assert.deepEqual(result, { plugins: [], failures: [] });
});
