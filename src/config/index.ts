import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { ConfigError } from "../core/errors.js";
import type { LogLevel } from "../core/logger.js";

loadDotenv({ quiet: true });

/** Outward-action policy: how aggressively agents may act on the world. */
export const ActionPolicy = z.enum(["ask", "auto", "deny"]);
export type ActionPolicy = z.infer<typeof ActionPolicy>;

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  EXEMPCLAW_MODEL: z.string().default("claude-opus-4-8"),
  EXEMPCLAW_DATA_DIR: z.string().default("./data"),
  EXEMPCLAW_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  EXEMPCLAW_ACTION_POLICY: ActionPolicy.default("ask"),
});

export interface RuntimeConfig {
  anthropicApiKey: string;
  defaultModel: string;
  dataDir: string;
  logLevel: LogLevel;
  actionPolicy: ActionPolicy;
}

/**
 * Loads and validates global runtime config from the environment. Throws a
 * ConfigError with a readable message if anything required is missing — this is
 * the single place env vars are read, so the rest of the code takes typed config.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  return {
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    defaultModel: e.EXEMPCLAW_MODEL,
    dataDir: e.EXEMPCLAW_DATA_DIR,
    logLevel: e.EXEMPCLAW_LOG_LEVEL,
    actionPolicy: e.EXEMPCLAW_ACTION_POLICY,
  };
}
