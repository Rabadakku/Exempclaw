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
   * a write-only connector (e.g. a metrics sink) can omit it. Runs until
   * `signal` aborts; the returned promise resolves when listening has stopped.
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
  /**
   * Unique id of this occurrence, used for at-least-once dedup across
   * restarts. Use the upstream system's id (message id, event ts, …).
   */
  eventId: string;
  /** Stable identifier of the conversation/thread, for routing + replies. */
  threadId: string;
  /** Human-readable summary used as the agent's user-turn input. */
  summary: string;
  /** Raw payload for tools that need full fidelity. */
  payload: unknown;
  receivedAt: string;
}

/** Renders an inbound event into the user-turn text fed to the agent. */
export function renderEventInput(event: InboundEvent): string {
  return [
    `[inbound event] connector=${event.connector} type=${event.type} thread=${event.threadId} received=${event.receivedAt}`,
    event.summary,
    "",
    "Handle this event in your role. Gather context with your tools first; reply in the originating thread if (and only if) a response is warranted.",
  ].join("\n");
}

/** Waits until the signal aborts. Shared by polling/listening loops. */
export function abortedPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** Abortable sleep that resolves early (without throwing) when aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
