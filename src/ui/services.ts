// src/ui/services.ts
import { loadConfig, loadOfflineConfig, type OfflineConfig } from "../config/index.js";
import { createLogger } from "../core/logger.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import type { ApprovalRequest } from "../tools/tool.js";
import { loadPlugins, type PluginLoadResult } from "../plugins/loader.js";
import { applyPlugins, type AppliedPlugins } from "../plugins/apply.js";
import { resolveAgentsDir, listAgents, type RegisteredAgent, type BrokenAgent } from "../agents/registry.js";

/** A pending outward-action approval surfaced to the UI. */
export interface PendingApproval {
  req: ApprovalRequest;
  resolve: (ok: boolean) => void;
}

/** Bridges the orchestrator's approve() callback to a React subscriber. */
export class ApprovalBridge {
  private listener?: (pending: PendingApproval | undefined) => void;
  current?: PendingApproval;

  approve = (req: ApprovalRequest): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const pending: PendingApproval = {
        req,
        resolve: (ok) => {
          this.current = undefined;
          this.listener?.(undefined);
          resolve(ok);
        },
      };
      this.current = pending;
      this.listener?.(pending);
    });

  subscribe(fn: (pending: PendingApproval | undefined) => void): () => void {
    this.listener = fn;
    if (this.current) fn(this.current);
    return () => {
      if (this.listener === fn) this.listener = undefined;
    };
  }
}

export interface Services {
  config: OfflineConfig;
  agentsDir: string;
  plugins: PluginLoadResult;
  applied: AppliedPlugins;
  approvals: ApprovalBridge;
  listAgents(): Promise<{ agents: RegisteredAgent[]; broken: BrokenAgent[] }>;
  /** Lazily builds the orchestrator with every registry agent added. Throws ConfigError without an API key. */
  getOrchestrator(): Promise<Orchestrator>;
  shutdown(): Promise<void>;
}

export async function createServices(): Promise<Services> {
  const config = loadOfflineConfig();
  const agentsDir = resolveAgentsDir();
  const plugins = await loadPlugins();
  const applied = applyPlugins(plugins);
  const approvals = new ApprovalBridge();
  let orchestratorPromise: Promise<Orchestrator> | undefined;

  const services: Services = {
    config,
    agentsDir,
    plugins,
    applied,
    approvals,
    listAgents: () => listAgents(agentsDir),
    getOrchestrator() {
      orchestratorPromise ??= (async () => {
        const runtime = loadConfig();
        const log = createLogger(runtime.logLevel);
        const orchestrator = new Orchestrator(runtime, log, approvals.approve, { extraTools: applied.extraTools });
        const { agents } = await listAgents(agentsDir);
        for (const agent of agents) await orchestrator.addAgent(agent.config);
        return orchestrator;
      })();
      return orchestratorPromise;
    },
    async shutdown() {
      if (orchestratorPromise) await (await orchestratorPromise).shutdown().catch(() => undefined);
    },
  };
  return services;
}
