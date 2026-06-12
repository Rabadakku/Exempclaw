import { z } from "zod";
import { sleep, type Connector, type ConnectorContext, type InboundEvent } from "../connector.js";
import { HttpJson, type FetchLike } from "../http.js";
import { ConnectorError } from "../../core/errors.js";
import { defineTool, type Tool } from "../../tools/tool.js";
import type { Logger } from "../../core/logger.js";

/**
 * Slack connector. Tools go through the Web API; inbound events arrive over
 * Socket Mode (no public HTTP endpoint needed — ideal for a terminal app).
 *
 * Requires a Slack app with:
 *  - a bot token (xoxb-…, SLACK_BOT_TOKEN) with chat:write, channels:read,
 *    channels:history, groups:history, im:history, users:read scopes;
 *  - for inbound events, Socket Mode enabled plus an app-level token
 *    (xapp-…, SLACK_APP_TOKEN) and event subscriptions for app_mention and
 *    message.im.
 */

interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
}

interface SlackChannel {
  id: string;
  name?: string;
}

export class SlackConnector implements Connector {
  readonly id = "slack";
  private log!: Logger;
  private api!: HttpJson;
  private appToken?: string;
  private selfUserId = "";
  private readonly channelIds = new Map<string, string>();
  private readonly userNames = new Map<string, string>();

  constructor(private readonly fetchImpl?: FetchLike) {}

  async init(ctx: ConnectorContext): Promise<void> {
    this.log = ctx.log.child({ scope: "connector", connector: this.id });
    const botToken = ctx.config.botToken;
    if (!botToken) {
      throw new ConnectorError(this.id, "missing SLACK_BOT_TOKEN (bot token, xoxb-…)");
    }
    this.appToken = ctx.config.appToken;
    this.api = new HttpJson({
      connector: this.id,
      baseUrl: "https://slack.com/api",
      headers: { authorization: `Bearer ${botToken}` },
      fetchImpl: this.fetchImpl,
    });

    const auth = await this.call<{ user_id: string; team: string; user: string }>("auth.test", {});
    this.selfUserId = auth.user_id;
    this.log.info("slack connected", { team: auth.team, botUser: auth.user });
  }

  /** Calls a Web API method, unwrapping Slack's {ok, error} envelope. */
  private async call<T>(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    // Write methods accept JSON; read methods take query params. Slack allows
    // GET with query for all the read methods used here.
    const isWrite = method.startsWith("chat.") || method === "auth.test";
    const response = isWrite
      ? await this.api.post<{ ok: boolean; error?: string } & T>(`/${method}`, { body: args, signal })
      : await this.api.get<{ ok: boolean; error?: string } & T>(`/${method}`, {
          query: args as Record<string, string | number | boolean | undefined>,
          signal,
        });
    if (!response.ok) {
      throw new ConnectorError(this.id, `${method} failed: ${response.error ?? "unknown_error"}`, {
        retryable: response.error === "ratelimited",
      });
    }
    return response;
  }

  /** Resolves "#name" or a bare name to a channel id; passes ids through. */
  private async resolveChannel(channel: string, signal?: AbortSignal): Promise<string> {
    const trimmed = channel.trim();
    if (/^[CGD][A-Z0-9]{6,}$/.test(trimmed)) return trimmed;
    const name = trimmed.replace(/^#/, "").toLowerCase();
    const cached = this.channelIds.get(name);
    if (cached) return cached;

    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await this.call<{ channels: SlackChannel[]; response_metadata?: { next_cursor?: string } }>(
        "conversations.list",
        { types: "public_channel,private_channel", limit: 200, exclude_archived: true, cursor },
        signal,
      );
      for (const ch of res.channels) {
        if (ch.name) this.channelIds.set(ch.name.toLowerCase(), ch.id);
      }
      const hit = this.channelIds.get(name);
      if (hit) return hit;
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    throw new ConnectorError(this.id, `channel not found: ${channel}`);
  }

  private async userName(userId: string, signal?: AbortSignal): Promise<string> {
    const cached = this.userNames.get(userId);
    if (cached) return cached;
    try {
      const res = await this.call<{ user: { name: string; profile?: { display_name?: string; real_name?: string } } }>(
        "users.info",
        { user: userId },
        signal,
      );
      const name = res.user.profile?.display_name || res.user.profile?.real_name || res.user.name;
      this.userNames.set(userId, name);
      return name;
    } catch {
      return userId; // name resolution is best-effort
    }
  }

  private async renderMessages(messages: SlackMessage[], signal?: AbortSignal): Promise<string> {
    const lines: string[] = [];
    for (const msg of messages) {
      const who = msg.bot_id ? `bot:${msg.bot_id}` : msg.user ? await this.userName(msg.user, signal) : "unknown";
      const threadMark = msg.reply_count ? ` [thread with ${msg.reply_count} replies, thread_ts=${msg.ts}]` : "";
      lines.push(`[ts=${msg.ts}] ${who}: ${msg.text ?? ""}${threadMark}`);
    }
    return lines.join("\n");
  }

  tools(): Tool[] {
    const listChannels = defineTool({
      name: "slack_list_channels",
      description: "List Slack channels the agent can see (id and name).",
      schema: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
      execute: async (input, ctx) => {
        const res = await this.call<{ channels: Array<SlackChannel & { is_member?: boolean }> }>(
          "conversations.list",
          { types: "public_channel,private_channel", limit: input.limit, exclude_archived: true },
          ctx.signal,
        );
        if (res.channels.length === 0) return { content: "No channels visible." };
        return {
          content: res.channels
            .map((c) => `${c.id}  #${c.name ?? "?"}${c.is_member ? " (member)" : ""}`)
            .join("\n"),
        };
      },
    });

    const readChannel = defineTool({
      name: "slack_read_channel",
      description: "Read recent messages from a Slack channel (newest last). Accepts a channel id or #name.",
      schema: z.object({
        channel: z.string(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      execute: async (input, ctx) => {
        const channel = await this.resolveChannel(input.channel, ctx.signal);
        const res = await this.call<{ messages: SlackMessage[] }>(
          "conversations.history",
          { channel, limit: input.limit },
          ctx.signal,
        );
        if (res.messages.length === 0) return { content: "No messages." };
        const rendered = await this.renderMessages(res.messages.slice().reverse(), ctx.signal);
        return { content: `channel=${channel}\n${rendered}` };
      },
    });

    const readThread = defineTool({
      name: "slack_read_thread",
      description: "Read a Slack thread by its channel and root thread_ts (newest last).",
      schema: z.object({
        channel: z.string(),
        threadTs: z.string().describe("The thread_ts of the root message."),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      execute: async (input, ctx) => {
        const channel = await this.resolveChannel(input.channel, ctx.signal);
        const res = await this.call<{ messages: SlackMessage[] }>(
          "conversations.replies",
          { channel, ts: input.threadTs, limit: input.limit },
          ctx.signal,
        );
        const rendered = await this.renderMessages(res.messages, ctx.signal);
        return { content: `channel=${channel} thread_ts=${input.threadTs}\n${rendered}` };
      },
    });

    const postMessage = defineTool({
      name: "slack_post_message",
      description:
        "Post a message to a Slack channel, or reply in a thread by passing threadTs. Acts outward; requires approval.",
      outward: true,
      schema: z.object({
        channel: z.string().describe("Channel id or #name."),
        text: z.string().min(1),
        threadTs: z.string().optional().describe("thread_ts of the root message to reply under."),
      }),
      execute: async (input, ctx) => {
        const channel = await this.resolveChannel(input.channel, ctx.signal);
        const res = await this.call<{ ts: string; channel: string }>(
          "chat.postMessage",
          {
            channel,
            text: input.text,
            ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
          },
          ctx.signal,
        );
        return { content: `Posted to ${res.channel} at ts=${res.ts}.` };
      },
    });

    return [listChannels, readChannel, readThread, postMessage];
  }

  /** Socket Mode loop: connect, ack envelopes, surface mentions and DMs. */
  async listen(onEvent: (event: InboundEvent) => void, signal: AbortSignal): Promise<void> {
    if (!this.appToken) {
      this.log.warn("SLACK_APP_TOKEN not set — slack inbound events disabled (tools still work)");
      return;
    }
    const appApi = new HttpJson({
      connector: this.id,
      baseUrl: "https://slack.com/api",
      headers: { authorization: `Bearer ${this.appToken}` },
      fetchImpl: this.fetchImpl,
    });

    let backoffMs = 1000;
    while (!signal.aborted) {
      try {
        const open = await appApi.post<{ ok: boolean; url?: string; error?: string }>("/apps.connections.open", {
          signal,
        });
        if (!open.ok || !open.url) {
          throw new ConnectorError(this.id, `apps.connections.open failed: ${open.error ?? "unknown_error"}`);
        }
        this.log.info("slack socket connecting");
        await this.runSocket(open.url, onEvent, signal);
        backoffMs = 1000; // clean cycle — reset backoff
      } catch (err) {
        if (signal.aborted) break;
        this.log.warn("slack socket error; reconnecting", { error: (err as Error).message });
        await sleep(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  /** One WebSocket session. Resolves when the socket closes or signal aborts. */
  private runSocket(url: string, onEvent: (event: InboundEvent) => void, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const close = () => ws.close();
      signal.addEventListener("abort", close, { once: true });

      const finish = (err?: Error) => {
        signal.removeEventListener("abort", close);
        if (err) reject(err);
        else resolve();
      };

      ws.addEventListener("error", () => finish(new Error("websocket error")));
      ws.addEventListener("close", () => finish());
      ws.addEventListener("message", (msg) => {
        const parsed = parseSocketMessage(String(msg.data));
        if (parsed.kind === "disconnect") {
          this.log.debug("slack socket disconnect requested", { reason: parsed.reason });
          ws.close();
          return;
        }
        if (parsed.kind !== "event") return;
        // Ack immediately — Slack retries unacked envelopes.
        ws.send(JSON.stringify({ envelope_id: parsed.envelopeId }));
        const event = slackEventToInbound(parsed.eventId, parsed.event, this.selfUserId);
        if (event) onEvent(event);
      });
    });
  }
}

/** Shapes of the Socket Mode frames we care about. */
export type SocketMessage =
  | { kind: "hello" }
  | { kind: "disconnect"; reason?: string }
  | { kind: "event"; envelopeId: string; eventId: string; event: Record<string, unknown> }
  | { kind: "other" };

export function parseSocketMessage(raw: string): SocketMessage {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { kind: "other" };
  }
  if (data.type === "hello") return { kind: "hello" };
  if (data.type === "disconnect") return { kind: "disconnect", reason: String(data.reason ?? "") };
  if (data.type === "events_api" && typeof data.envelope_id === "string") {
    const payload = (data.payload ?? {}) as Record<string, unknown>;
    const event = (payload.event ?? {}) as Record<string, unknown>;
    return {
      kind: "event",
      envelopeId: data.envelope_id,
      eventId: String(payload.event_id ?? data.envelope_id),
      event,
    };
  }
  return { kind: "other" };
}

/** Maps a Slack event payload to an InboundEvent (or null if irrelevant). */
export function slackEventToInbound(
  eventId: string,
  event: Record<string, unknown>,
  selfUserId: string,
): InboundEvent | null {
  const type = String(event.type ?? "");
  const user = typeof event.user === "string" ? event.user : "";
  if (event.bot_id || user === selfUserId || !user) return null;
  if (event.subtype) return null; // edits, joins, etc.

  const channel = String(event.channel ?? "");
  const ts = String(event.ts ?? event.event_ts ?? "");
  const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : ts;
  const text = String(event.text ?? "");

  const isMention = type === "app_mention";
  const isDm = type === "message" && event.channel_type === "im";
  if (!isMention && !isDm) return null;

  return {
    connector: "slack",
    type: isMention ? "slack.mention" : "slack.dm",
    eventId,
    threadId: `${channel}:${threadTs}`,
    summary: [
      `${isMention ? "Mention" : "Direct message"} from user ${user} in channel ${channel} (ts=${ts}, thread_ts=${threadTs}).`,
      `Reply with slack_post_message using channel="${channel}" and threadTs="${threadTs}".`,
      "",
      text,
    ].join("\n"),
    payload: event,
    receivedAt: new Date().toISOString(),
  };
}
