import { loadOfflineConfig, type ActionPolicy, type RuntimeConfig } from "../config/index.js";
import { createLogger } from "../core/logger.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { AgentConfigSchema } from "../agent/config.js";
import type { ApprovalRequest } from "../tools/tool.js";
import { DemoClaude, type DemoClaudeOptions } from "./claude.js";
import { DEMO_SEED_MEMORIES } from "./world.js";

/**
 * Boots the offline demo: the real orchestrator/agent/tool/memory stack with
 * a scripted brain (DemoClaude) and the fictional demo connector. No API key,
 * no credentials, no network. State persists under the normal data dir with
 * a clearly-prefixed agent id, so `memory`, `history`, `costs`, and the
 * dashboard all work on it afterwards.
 */

export const DEMO_AGENT_ID = "demo-jordan-support-lead";
export const DEMO_MODEL = "claude-demo";

const DEMO_AGENT_CONFIG = AgentConfigSchema.parse({
  id: DEMO_AGENT_ID,
  persona: {
    name: "Jordan",
    role: "Customer Support Lead",
    succeeds: "Alex Rivera",
    tone: "warm, concise, proactive",
    guidance: "Prioritize unblocking customers quickly. Never commit to engineering timelines in writing.",
    disclosure: "transparent",
  },
  model: DEMO_MODEL,
  connectors: ["demo"],
  maxIterations: 12,
});

export interface DemoBootstrapOptions extends DemoClaudeOptions {
  policy?: ActionPolicy;
  approve: (req: ApprovalRequest) => Promise<boolean>;
  /** Override the data dir (tests). Defaults to the configured EXEMPCLAW_DATA_DIR. */
  dataDir?: string;
}

export async function bootstrapDemo(opts: DemoBootstrapOptions): Promise<{
  orchestrator: Orchestrator;
  agentId: string;
  name: string;
  model: string;
}> {
  const offline = loadOfflineConfig();
  const config: RuntimeConfig = {
    ...offline,
    anthropicApiKey: "demo-key-never-used",
    defaultModel: DEMO_MODEL,
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    ...(opts.policy ? { actionPolicy: opts.policy } : {}),
  };
  // Errors only: denials/tool failures already render in the TUI, and log
  // lines would tear the animated live region mid-stream.
  const log = createLogger("error");
  const orchestrator = new Orchestrator(config, log, opts.approve, {
    claude: new DemoClaude({ latencyMs: opts.latencyMs, streamDelayMs: opts.streamDelayMs }),
  });
  await orchestrator.addAgent(DEMO_AGENT_CONFIG);

  // First boot: seed the role memory so recall/“/memory” have substance.
  const { memory } = orchestrator.resources(DEMO_AGENT_ID);
  if ((await memory.allMemories()).length === 0) {
    for (const seed of DEMO_SEED_MEMORIES) {
      await memory.addMemory({ text: seed.text, source: "onboarding", tags: seed.tags });
    }
  }

  return {
    orchestrator,
    agentId: DEMO_AGENT_ID,
    name: DEMO_AGENT_CONFIG.persona.name,
    model: DEMO_MODEL,
  };
}
