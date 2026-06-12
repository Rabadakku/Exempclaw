import type { Logger } from "../core/logger.js";
import type { Tool } from "../tools/tool.js";

/**
 * A connector integrates one external system (email, Slack, Notion, GitHub).
 * It contributes two things to an agent:
 *
 *  1. **Tools** — capabilities the agent can call (read a thread, send a reply).
 *  2. **Events** — inbound triggers (a new email, a Slack mention) the
 *     orchestrator routes to the right agent's run loop.
 *
 * Connectors are the primary extension point. Adding an integration means
 * implementing this interface; nothing in the core changes.
 */
export interface Connector {
  /** Stable identifier, e.g. "email", "slack". */
  readonly id: string;

  /** Establish credentials/sessions. Called once before the connector is used. */
  init(ctx: ConnectorContext): Promise<void>;

  /** Tools this connector exposes to agents. */
  tools(): Tool[];

  /**
   * Begin listening for inbound events, delivering each to `onEvent`. Optional —
   * a write-only connector (e.g. a metrics sink) can omit it. Should resolve
   * once listening has started and run until `signal` aborts.
   */
  listen?(onEvent: (event: InboundEvent) => void, signal: AbortSignal): Promise<void>;

  /** Release resources. */
  shutdown?(): Promise<void>;
}

export interface ConnectorContext {
  log: Logger;
  /** Connector-specific credentials/config, already validated by the loader. */
  config: Record<string, string>;
}

/** A normalized inbound trigger produced by a connector. */
export interface InboundEvent {
  connector: string;
  /** e.g. "email.received", "slack.mention". */
  type: string;
  /** Stable identifier of the conversation/thread, for routing + dedup. */
  threadId: string;
  /** Human-readable summary used as the agent's user-turn input. */
  summary: string;
  /** Raw payload for tools that need full fidelity. */
  payload: unknown;
  receivedAt: string;
}
