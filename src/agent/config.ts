import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ConfigError } from "../core/errors.js";
import { PersonaSchema } from "./persona.js";

/**
 * On-disk description of a single agent. One JSON file per agent (see
 * examples/agents). The orchestrator loads these to spin up agents.
 */
export const AgentConfigSchema = z.object({
  id: z.string().min(1),
  persona: PersonaSchema,
  /** Override the global default model for this agent. */
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** Connector ids this agent is wired to, e.g. ["email", "slack"]. */
  connectors: z.array(z.string()).default([]),
  maxIterations: z.number().int().min(1).max(200).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export async function loadAgentConfig(path: string): Promise<AgentConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`could not read agent config at ${path}: ${(err as Error).message}`);
  }
  const parsed = AgentConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new ConfigError(`invalid agent config at ${path}:\n${issues}`);
  }
  return parsed.data;
}
