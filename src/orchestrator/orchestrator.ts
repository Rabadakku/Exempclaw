import type { RuntimeConfig } from "../config/index.js";
import type { Logger } from "../core/logger.js";
import { ClaudeClient } from "../llm/claude.js";
import { Agent } from "../agent/agent.js";
import type { AgentConfig } from "../agent/config.js";
import { FileMemoryStore } from "../memory/file-store.js";
import { ToolRegistry, type ApprovalRequest } from "../tools/tool.js";
import { builtinTools } from "../tools/builtin.js";
import { createConnector, type Connector, type InboundEvent } from "../connectors/index.js";

interface ManagedAgent {
  agent: Agent;
  connectors: Connector[];
}

/**
 * Runs and supervises many agents at once. Responsibilities:
 *  - build each agent's Claude client, tool registry (builtins + connector tools),
 *    and memory store;
 *  - initialize the agent's connectors;
 *  - route inbound connector events to the owning agent's run loop;
 *  - serialize each agent's runs so a single agent never overlaps itself.
 */
export class Orchestrator {
  private readonly claude: ClaudeClient;
  private readonly managed = new Map<string, ManagedAgent>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly abort = new AbortController();

  constructor(
    private readonly config: RuntimeConfig,
    private readonly log: Logger,
    private readonly approve: (req: ApprovalRequest) => Promise<boolean>,
  ) {
    this.claude = new ClaudeClient(config.anthropicApiKey, config.defaultModel, log);
  }

  /** Builds an agent from its config and registers it (does not start listening). */
  async addAgent(cfg: AgentConfig): Promise<Agent> {
    if (this.managed.has(cfg.id)) {
      throw new Error(`agent "${cfg.id}" already added`);
    }
    const log = this.log.child({ scope: "orchestrator", agentId: cfg.id });
    const memory = new FileMemoryStore(this.config.dataDir, cfg.id);

    const tools = new ToolRegistry();
    for (const t of builtinTools(memory)) tools.register(t);

    const connectors: Connector[] = [];
    for (const connectorId of cfg.connectors) {
      const { connector, config } = createConnector(connectorId);
      await connector.init({ log, config });
      for (const t of connector.tools()) tools.register(t);
      connectors.push(connector);
    }

    const agent = new Agent(
      {
        id: cfg.id,
        persona: cfg.persona,
        model: cfg.model ?? this.config.defaultModel,
        effort: cfg.effort,
        maxIterations: cfg.maxIterations,
      },
      {
        claude: this.claude,
        tools,
        memory,
        log,
        actionPolicy: this.config.actionPolicy,
        approve: this.approve,
      },
    );

    this.managed.set(cfg.id, { agent, connectors });
    log.info("agent ready", {
      persona: cfg.persona.name,
      tools: tools.size,
      connectors: cfg.connectors.join(",") || "none",
    });
    return agent;
  }

  /** Feeds one input to an agent, serialized behind that agent's queue. */
  async dispatch(agentId: string, input: string): Promise<string> {
    const managed = this.managed.get(agentId);
    if (!managed) throw new Error(`no such agent: ${agentId}`);

    const prior = this.queues.get(agentId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined) // a failed prior run must not poison the queue
      .then(() => managed.agent.run(input, this.abort.signal));
    this.queues.set(agentId, next);
    const result = await next;
    return result.text;
  }

  /**
   * Starts every agent's connectors listening and routes inbound events to the
   * owning agent. Resolves only when shutdown() aborts the run.
   */
  async start(): Promise<void> {
    const listeners: Promise<void>[] = [];
    for (const [agentId, managed] of this.managed) {
      for (const connector of managed.connectors) {
        if (!connector.listen) continue;
        const onEvent = (event: InboundEvent) => {
          this.log.info("inbound event", { agentId, connector: event.connector, type: event.type });
          void this.dispatch(agentId, `[${event.type}] ${event.summary}`).catch((err) =>
            this.log.error("dispatch failed", { agentId, error: (err as Error).message }),
          );
        };
        listeners.push(connector.listen(onEvent, this.abort.signal));
      }
    }
    this.log.info("orchestrator started", { agents: this.managed.size, listeners: listeners.length });
    await Promise.all(listeners);
  }

  async shutdown(): Promise<void> {
    this.abort.abort();
    for (const managed of this.managed.values()) {
      for (const connector of managed.connectors) {
        await connector.shutdown?.();
      }
    }
    this.log.info("orchestrator stopped");
  }

  agentIds(): string[] {
    return [...this.managed.keys()];
  }
}
