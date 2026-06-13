import { z } from "zod";
import { defineTool, type Tool } from "../tools/tool.js";
import type { Connector } from "../connectors/connector.js";
import type { ConnectorEnvKey } from "../connectors/index.js";

/**
 * Public plugin API. Plugin authors either:
 *  - default-export `definePlugin({...})` (requires `npm i exempclaw zod` in the
 *    plugin folder so imports resolve), or
 *  - default-export a factory `(api: PluginApi) => PluginSpec` — zero installs,
 *    the loader passes this module in. The scaffold uses the factory form.
 */
export interface PluginConnector {
  id: string;
  description: string;
  envKeys: ConnectorEnvKey[];
  make: () => Connector;
}

export interface PluginSpec {
  name: string;
  tools?: Tool[];
  connectors?: PluginConnector[];
}

export function definePlugin(spec: PluginSpec): PluginSpec {
  if (!spec.name || typeof spec.name !== "string") {
    throw new Error("plugin name is required (non-empty string)");
  }
  const seen = new Set<string>();
  for (const tool of spec.tools ?? []) {
    if (seen.has(tool.name)) throw new Error(`duplicate tool in plugin "${spec.name}": ${tool.name}`);
    seen.add(tool.name);
  }
  const seenConnectors = new Set<string>();
  for (const connector of spec.connectors ?? []) {
    if (!connector.id || typeof connector.make !== "function") {
      throw new Error(`invalid connector in plugin "${spec.name}": needs id and make()`);
    }
    if (seenConnectors.has(connector.id)) {
      throw new Error(`duplicate connector id in plugin "${spec.name}": ${connector.id}`);
    }
    seenConnectors.add(connector.id);
  }
  return {
    name: spec.name,
    tools: spec.tools ? [...spec.tools] : undefined,
    connectors: spec.connectors ? [...spec.connectors] : undefined,
  };
}

export const pluginApi = { z, defineTool, definePlugin };
export type PluginApi = typeof pluginApi;
