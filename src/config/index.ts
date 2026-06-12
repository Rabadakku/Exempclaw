import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { ConfigError } from "../core/errors.js";
import type { LogLevel } from "../core/logger.js";

loadDotenv({ quiet: true });

/** Outward-action policy: how aggressively agents may act on the world. */
export const ActionPolicy = z.enum(["ask", "auto", "deny"]);
export type ActionPolicy = z.infer<typeof ActionPolicy>;

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  EXEMPCLAW_MODEL: z.string().default("claude-opus-4-8"),
  EXEMPCLAW_DATA_DIR: z.string().default("./data"),
  EXEMPCLAW_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  EXEMPCLAW_ACTION_POLICY: ActionPolicy.default("ask"),
  /** Compact an agent's history once its prompt exceeds this many tokens. */
  EXEMPCLAW_CONTEXT_BUDGET_TOKENS: z.coerce.number().int().min(20_000).default(200_000),
});

/** Config available without an Anthropic key (offline CLI commands). */
export interface OfflineConfig {
  anthropicApiKey?: string;
  defaultModel: string;
  dataDir: string;
  logLevel: LogLevel;
  actionPolicy: ActionPolicy;
  contextBudgetTokens: number;
}

/** Full runtime config; the API key is guaranteed present. */
export interface RuntimeConfig extends OfflineConfig {
  anthropicApiKey: string;
}

/**
 * Loads config from the environment without requiring the API key. Used by
 * commands that only touch local state (memory, history, costs, doctor).
 */
export function loadOfflineConfig(env: NodeJS.ProcessEnv = process.env): OfflineConfig {
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
    contextBudgetTokens: e.EXEMPCLAW_CONTEXT_BUDGET_TOKENS,
  };
}

/**
 * Loads and validates the full runtime config. Throws a ConfigError with a
 * readable message if anything required is missing — this is the single place
 * env vars are read, so the rest of the code takes typed config.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const offline = loadOfflineConfig(env);
  if (!offline.anthropicApiKey) {
    throw new ConfigError(
      "ANTHROPIC_API_KEY is required. Set it in your environment or .env (see .env.example).",
    );
  }
  return { ...offline, anthropicApiKey: offline.anthropicApiKey };
}
