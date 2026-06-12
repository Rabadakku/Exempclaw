import { z } from "zod";
import type { Connector, ConnectorContext } from "../connectors/connector.js";
import { defineTool, type Tool } from "../tools/tool.js";
import type { Logger } from "../core/logger.js";
import { DemoWorld } from "./world.js";

/**
 * The demo connector: the same email/Slack tool surface as the real
 * connectors (same names, same schemas, same outward gating), backed by the
 * fictional DemoWorld instead of IMAP/Slack. Needs no credentials.
 *
 * It exists for demo mode, but it's also handy as a sandbox: point any agent
 * (including one running on the real Claude API) at `"connectors": ["demo"]`
 * and let it act on the fictional workspace safely.
 */
export class DemoConnector implements Connector {
  readonly id = "demo";
  readonly world = new DemoWorld();
  private log!: Logger;

  async init(ctx: ConnectorContext): Promise<void> {
    this.log = ctx.log.child({ scope: "connector", connector: this.id });
    this.log.debug("demo connector ready (fictional workspace, no credentials)");
  }

  tools(): Tool[] {
    const world = this.world;

    const listInbox = defineTool({
      name: "email_list_inbox",
      description: "List recent inbox messages (newest first) with their uid, sender, subject, and read state.",
      schema: z.object({
        limit: z.number().int().min(1).max(50).default(10),
        unreadOnly: z.boolean().default(false),
      }),
      execute: async (input) => {
        const rows = world.emails
          .filter((e) => (input.unreadOnly ? !e.seen : true))
          .slice(-input.limit)
          .reverse()
          .map(
            (e) =>
              `uid=${e.uid}${e.seen ? "" : " [unread]"} ${e.date} from ${e.from} — ${e.subject} messageId=${e.messageId}`,
          );
        return { content: rows.length ? rows.join("\n") : "Inbox is empty." };
      },
    });

    const readMessage = defineTool({
      name: "email_read_message",
      description: "Read one email in full by its uid (from email_list_inbox or email_search).",
      schema: z.object({ uid: z.number().int().min(1) }),
      execute: async (input) => {
        const mail = world.findEmail(input.uid);
        if (!mail) return { content: `No message with uid ${input.uid}.`, isError: true };
        return {
          content: [
            `uid=${mail.uid}`,
            `From: ${mail.from}`,
            `To: ${mail.to}`,
            `Date: ${mail.date}`,
            `Subject: ${mail.subject}`,
            `messageId: ${mail.messageId}`,
            "",
            mail.body,
          ].join("\n"),
        };
      },
    });

    const searchMail = defineTool({
      name: "email_search",
      description: "Search the inbox by sender, subject, body text, and/or age. Returns matching messages, newest first.",
      schema: z.object({
        from: z.string().optional(),
        subject: z.string().optional(),
        text: z.string().optional(),
        sinceDays: z.number().int().min(1).max(365).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      execute: async (input) => {
        const hits = world.searchEmails(input).slice(-input.limit).reverse();
        if (hits.length === 0) return { content: "No matching messages." };
        return {
          content: hits
            .map((e) => `uid=${e.uid}${e.seen ? "" : " [unread]"} ${e.date} from ${e.from} — ${e.subject} messageId=${e.messageId}`)
            .join("\n"),
        };
      },
    });

    const markRead = defineTool({
      name: "email_mark_read",
      description: "Mark a message as read (seen) by uid once you've handled it.",
      schema: z.object({ uid: z.number().int().min(1) }),
      execute: async (input) => {
        const mail = world.findEmail(input.uid);
        if (!mail) return { content: `No message with uid ${input.uid}.`, isError: true };
        mail.seen = true;
        return { content: `Marked uid ${input.uid} as read.` };
      },
    });

    const sendEmail = defineTool({
      name: "email_send",
      description:
        "Send an email. To reply within a thread, pass the original message's messageId as inReplyTo. Acts outward; requires approval.",
      outward: true,
      schema: z.object({
        to: z.array(z.string().email()).min(1),
        cc: z.array(z.string().email()).default([]),
        subject: z.string().min(1),
        body: z.string().min(1),
        inReplyTo: z.string().optional(),
      }),
      execute: async (input) => {
        world.sendEmail({ to: input.to, subject: input.subject, body: input.body, inReplyTo: input.inReplyTo });
        return { content: `Sent "${input.subject}" to ${input.to.join(", ")} (id <demo-sent-${world.sentEmails.length}@acme.example>).` };
      },
    });

    const listChannels = defineTool({
      name: "slack_list_channels",
      description: "List Slack channels the agent can see (id and name).",
      schema: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
      execute: async () => ({
        content: world.channels.map((c) => `${c.id}  #${c.name} (member)`).join("\n"),
      }),
    });

    const readChannel = defineTool({
      name: "slack_read_channel",
      description: "Read recent messages from a Slack channel (newest last). Accepts a channel id or #name.",
      schema: z.object({ channel: z.string(), limit: z.number().int().min(1).max(100).default(20) }),
      execute: async (input) => {
        const channel = world.findChannel(input.channel);
        if (!channel) return { content: `channel not found: ${input.channel}`, isError: true };
        const rows = channel.messages.slice(-input.limit).map((m) => `[ts=${m.ts}] ${m.user}: ${m.text}`);
        return { content: `channel=${channel.id}\n${rows.join("\n")}` };
      },
    });

    const readThread = defineTool({
      name: "slack_read_thread",
      description: "Read a Slack thread by its channel and root thread_ts (newest last).",
      schema: z.object({
        channel: z.string(),
        threadTs: z.string(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      execute: async (input) => {
        const channel = world.findChannel(input.channel);
        if (!channel) return { content: `channel not found: ${input.channel}`, isError: true };
        const rows = channel.messages
          .filter((m) => m.ts === input.threadTs || m.threadTs === input.threadTs)
          .map((m) => `[ts=${m.ts}] ${m.user}: ${m.text}`);
        return { content: rows.length ? rows.join("\n") : "(empty thread)" };
      },
    });

    const postMessage = defineTool({
      name: "slack_post_message",
      description:
        "Post a message to a Slack channel, or reply in a thread by passing threadTs. Acts outward; requires approval.",
      outward: true,
      schema: z.object({
        channel: z.string(),
        text: z.string().min(1),
        threadTs: z.string().optional(),
      }),
      execute: async (input) => {
        const channel = world.findChannel(input.channel);
        if (!channel) return { content: `channel not found: ${input.channel}`, isError: true };
        const ts = world.postMessage(channel, input.text, input.threadTs);
        return { content: `Posted to ${channel.id} at ts=${ts}.` };
      },
    });

    return [listInbox, readMessage, searchMail, markRead, sendEmail, listChannels, readChannel, readThread, postMessage];
  }
}
