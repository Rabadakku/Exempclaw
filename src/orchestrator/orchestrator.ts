import type { RuntimeConfig } from "../config/index.js";
import type { Logger } from "../core/logger.js";
import { ClaudeClient, type ClaudeLike } from "../llm/claude.js";
import { RunLog } from "../core/run-log.js";
import { Agent, type RunHooks, type RunResult } from "../agent/agent.js";
import type { AgentConfig } from "../agent/config.js";
import { FileMemoryStore } from "../memory/file-store.js";
import type { MemoryStore } from "../memory/store.js";
import { ToolRegistry, type ApprovalRequest, type Tool } from "../tools/tool.js";
import { builtinTools } from "../tools/builtin.js";
import {
  createConnector,
  renderEventInput,
  type Connector,
  type InboundEvent,
} from "../connectors/index.js";
import { abortedPromise } from "../connectors/connector.js";
import { Scheduler } from "./scheduler.js";
import { SeenEvents } from "./seen-events.js";
import type { TriggerKind } from "../core/run-log.js";

interface ManagedAgent {
  agent: Agent;
  config: AgentConfig;
  connectors: Connector[];
  memory: MemoryStore;
  runLog: RunLog;
  seen: SeenEvents;
  scheduler?: Scheduler;
}

export interface DispatchOptions {
  hooks?: RunHooks;
  trigger?: { kind: TriggerKind; detail?: string };
  /** Per-run cancellation (combined with the orchestrator's shutdown signal). */
  signal?: AbortSignal;
}

/**
 * Runs and supervises many agents at once. Responsibilities:
 *  - build each agent's Claude client, tool registry (builtins + connector tools),
 *    memory store, run log, and dedup state;
 *  - initialize the agent's connectors;
 *  - route inbound connector events to the owning agent's run loop (with
 *    at-least-once dedup persisted across restarts);
 *  - fire the agent's schedules;
 *  - serialize each agent's runs so a single agent never overlaps itself.
 */
export class Orchestrator {
  private readonly claude: ClaudeLike;
  private readonly managed = new Map<string, ManagedAgent>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly abort = new AbortController();
  private readonly extraTools: Tool[];

  /** Optional observer for inbound events that pass dedup (CLI flash lines). */
  onInboundEvent?: (agentId: string, event: InboundEvent) => void;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly log: Logger,
    private readonly approve: (req: ApprovalRequest) => Promise<boolean>,
    opts: { claude?: ClaudeLike; extraTools?: Tool[] } = {},
  ) {
    // Demo mode injects a scripted brain; everything else is identical.
    this.claude = opts.claude ?? new ClaudeClient(config.anthropicApiKey, config.defaultModel, log);
    this.extraTools = opts.extraTools ?? [];
  }

  /** Builds an agent from its config and registers it (does not start listening). */
  async addAgent(cfg: AgentConfig): Promise<Agent> {
    if (this.managed.has(cfg.id)) {
      throw new Error(`agent "${cfg.id}" already added`);
    }
    const log = this.log.child({ scope: "orchestrator", agentId: cfg.id });
    const memory = new FileMemoryStore(this.config.dataDir, cfg.id);
    const runLog = new RunLog(this.config.dataDir, cfg.id);
    const seen = new SeenEvents(this.config.dataDir, cfg.id);

    const tools = new ToolRegistry();
    for (const t of builtinTools(memory)) tools.register(t);
    for (const t of this.extraTools) tools.register(t);

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
        toolPolicies: cfg.toolPolicies,
        contextBudgetTokens: this.config.contextBudgetTokens,
      },
      {
        claude: this.claude,
        tools,
        memory,
        log,
        actionPolicy: this.config.actionPolicy,
        approve: this.approve,
        runLog,
      },
    );

    this.managed.set(cfg.id, { agent, config: cfg, connectors, memory, runLog, seen });
    log.info("agent ready", {
      persona: cfg.persona.name,
      tools: tools.size,
      connectors: cfg.connectors.join(",") || "none",
      schedules: cfg.schedules.length,
    });
    return agent;
  }

  /** Feeds one input to an agent, serialized behind that agent's queue. */
  async dispatch(agentId: string, input: string, options: DispatchOptions = {}): Promise<RunResult> {
    const managed = this.managed.get(agentId);
    if (!managed) throw new Error(`no such agent: ${agentId}`);

    const signal = options.signal ? AbortSignal.any([this.abort.signal, options.signal]) : this.abort.signal;
    const prior = this.queues.get(agentId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined) // a failed prior run must not poison the queue
      .then(() =>
        managed.agent.run(input, {
          signal,
          hooks: options.hooks,
          trigger: options.trigger,
        }),
      );
    this.queues.set(agentId, next);
    return next;
  }

  /** Direct access to an agent's stores, for the memory/history/costs CLI. */
  resources(agentId: string): { memory: MemoryStore; runLog: RunLog } {
    const managed = this.managed.get(agentId);
    if (!managed) throw new Error(`no such agent: ${agentId}`);
    return { memory: managed.memory, runLog: managed.runLog };
  }

  /**
   * Starts every agent's connectors listening, arms schedules, and routes
   * inbound events to the owning agent. Resolves after shutdown() aborts and
   * listeners have settled.
   */
  async start(): Promise<void> {
    const listeners: Promise<void>[] = [];
    let listenerCount = 0;

    for (const [agentId, managed] of this.managed) {
      // Connector listeners → dedup → agent queue.
      for (const connector of managed.connectors) {
        if (!connector.listen) continue;
        listenerCount++;
        const onEvent = (event: InboundEvent) => void this.handleEvent(agentId, managed, event);
        listeners.push(
          connector.listen(onEvent, this.abort.signal).catch((err) => {
            this.log.error("connector listener crashed", {
              agentId,
              connector: connector.id,
              error: (err as Error).message,
            });
          }),
        );
      }

      // Schedules → agent queue.
      if (managed.config.schedules.length > 0) {
        managed.scheduler = new Scheduler(managed.config.schedules, (schedule) => {
          const detail = schedule.every ? `every ${schedule.every}` : `daily at ${schedule.dailyAt}`;
          this.log.info("schedule fired", { agentId, detail });
          void this.dispatch(agentId, schedule.input, { trigger: { kind: "schedule", detail } }).catch((err) =>
            this.log.error("scheduled run failed", { agentId, error: (err as Error).message }),
          );
        });
        managed.scheduler.start();
      }
    }

    this.log.info("orchestrator started", { agents: this.managed.size, listeners: listenerCount });
    await abortedPromise(this.abort.signal);
    await Promise.allSettled(listeners);
  }

  private async handleEvent(agentId: string, managed: ManagedAgent, event: InboundEvent): Promise<void> {
    try {
      const fresh = await managed.seen.markSeen(`${event.connector}:${event.eventId}`);
      if (!fresh) {
        this.log.debug("duplicate event dropped", { agentId, eventId: event.eventId });
        return;
      }
      this.log.info("inbound event", { agentId, connector: event.connector, type: event.type });
      this.onInboundEvent?.(agentId, event);
      await this.dispatch(agentId, renderEventInput(event), {
        trigger: { kind: "event", detail: `${event.type} ${event.threadId}` },
      });
    } catch (err) {
      this.log.error("event dispatch failed", { agentId, error: (err as Error).message });
    }
  }

  async shutdown(): Promise<void> {
    this.abort.abort();
    for (const managed of this.managed.values()) {
      managed.scheduler?.stop();
      for (const connector of managed.connectors) {
        await connector.shutdown?.().catch(() => undefined);
      }
      await managed.seen.persist().catch(() => undefined);
    }
    this.log.info("orchestrator stopped");
  }

  agentIds(): string[] {
    return [...this.managed.keys()];
  }
}
