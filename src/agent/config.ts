import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ConfigError } from "../core/errors.js";
import { PersonaSchema } from "./persona.js";
import { ActionPolicy } from "../config/index.js";

/** A recurring input fed to the agent on a timer, e.g. a daily standup. */
export const ScheduleSchema = z
  .object({
    /** Interval form: "30s", "15m", "2h", "1d". */
    every: z.string().regex(/^\d+(s|m|h|d)$/, 'use a duration like "15m", "2h", "1d"').optional(),
    /** Daily form: fire at a local wall-clock time, "HH:MM". */
    dailyAt: z
      .string()
      .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'use a 24h time like "09:00"')
      .optional(),
    /** The instruction to feed the agent when the schedule fires. */
    input: z.string().min(1),
  })
  .refine((s) => (s.every !== undefined) !== (s.dailyAt !== undefined), {
    message: 'exactly one of "every" or "dailyAt" is required',
  });
export type Schedule = z.infer<typeof ScheduleSchema>;

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
  /**
   * Per-tool approval-policy overrides; "*" matches any tool. Example:
   * { "slack_post_message": "auto", "*": "ask" }.
   */
  toolPolicies: z.record(z.string(), ActionPolicy).optional(),
  /** Recurring inputs, e.g. a morning triage pass. */
  schedules: z.array(ScheduleSchema).default([]),
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
