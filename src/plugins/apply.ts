import type { Tool } from "../tools/tool.js";
import { registerConnector } from "../connectors/index.js";
import type { FailedPlugin, PluginLoadResult } from "./loader.js";

export interface AppliedPlugins {
  /** Plugin tools, registered into every agent's ToolRegistry by the orchestrator. */
  extraTools: Tool[];
  /** Loader failures plus apply-time failures (e.g. connector id collisions). */
  failures: FailedPlugin[];
}

export function applyPlugins(result: PluginLoadResult): AppliedPlugins {
  const extraTools: Tool[] = [];
  const failures = [...result.failures];
  for (const plugin of result.plugins) {
    try {
      for (const connector of plugin.spec.connectors ?? []) registerConnector(connector);
      extraTools.push(...(plugin.spec.tools ?? []));
    } catch (err) {
      failures.push({ dir: plugin.dir, name: plugin.manifest.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { extraTools, failures };
}
