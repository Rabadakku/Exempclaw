import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadAgentConfig, AgentConfigSchema, type AgentConfig } from "../agent/config.js";

export interface RegisteredAgent {
  path: string;
  config: AgentConfig;
}
export interface BrokenAgent {
  path: string;
  error: string;
}

/**
 * Resolution order: EXEMPCLAW_AGENTS_DIR → ./agents when it exists (project-local
 * use) → ~/.exempclaw/agents (the default for globally installed users).
 */
export function resolveAgentsDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  if (env.EXEMPCLAW_AGENTS_DIR) return env.EXEMPCLAW_AGENTS_DIR;
  const local = join(cwd, "agents");
  if (existsSync(local)) return local;
  return join(homedir(), ".exempclaw", "agents");
}

export async function listAgents(dir: string): Promise<{ agents: RegisteredAgent[]; broken: BrokenAgent[] }> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return { agents: [], broken: [] };
  }
  const agents: RegisteredAgent[] = [];
  const broken: BrokenAgent[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    try {
      agents.push({ path, config: await loadAgentConfig(path) });
    } catch (err) {
      broken.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { agents, broken };
}

/** Validates and writes <dir>/<id>.json. Refuses to overwrite an existing agent. */
export async function saveAgent(dir: string, config: z.input<typeof AgentConfigSchema>): Promise<string> {
  const parsed = AgentConfigSchema.parse(config);
  const path = join(dir, `${parsed.id}.json`);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return path;
}
