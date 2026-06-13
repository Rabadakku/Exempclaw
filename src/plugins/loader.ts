import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { pluginApi, type PluginSpec } from "./define.js";

const ManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(""),
  entry: z.string().default("./index.js"),
});
export type PluginManifest = z.infer<typeof ManifestSchema>;

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  spec: PluginSpec;
}
export interface FailedPlugin {
  dir: string;
  /** Manifest name when known, else the folder name. */
  name: string;
  error: string;
}
export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  failures: FailedPlugin[];
}

export function defaultPluginsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.EXEMPCLAW_PLUGINS_DIR ?? join(homedir(), ".exempclaw", "plugins");
}

/**
 * Discovers and imports every plugin folder. A broken plugin becomes a
 * `failures` entry — it must never throw out of this function.
 */
export async function loadPlugins(dir: string = defaultPluginsDir()): Promise<PluginLoadResult> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { plugins: [], failures: [] };
  }

  const plugins: LoadedPlugin[] = [];
  const failures: FailedPlugin[] = [];

  for (const entry of entries.sort()) {
    const pluginDir = join(dir, entry);
    try {
      if (!(await stat(pluginDir)).isDirectory()) continue;
    } catch {
      continue;
    }
    let manifest: PluginManifest | undefined;
    try {
      const manifestRaw = await readFile(join(pluginDir, "exempclaw.plugin.json"), "utf8");
      manifest = ManifestSchema.parse(JSON.parse(manifestRaw));
      const entryUrl = pathToFileURL(join(pluginDir, manifest.entry)).href;
      const mod = (await import(entryUrl)) as { default?: unknown };
      const exported = mod.default;
      const rawSpec = typeof exported === "function"
        ? (exported as (api: typeof pluginApi) => PluginSpec | Promise<PluginSpec>)(pluginApi)
        : exported;
      const spec = rawSpec instanceof Promise ? await rawSpec : rawSpec;
      if (!spec || typeof spec !== "object" || typeof (spec as PluginSpec).name !== "string") {
        throw new Error("entry default export must be a PluginSpec or a factory returning one");
      }
      plugins.push({ manifest, dir: pluginDir, spec: spec as PluginSpec });
    } catch (err) {
      failures.push({ dir: pluginDir, name: manifest?.name ?? entry, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { plugins, failures };
}
