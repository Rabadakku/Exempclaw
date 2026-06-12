import { z } from "zod";
import { ImapFlow, type FetchMessageObject, type ImapFlowOptions } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { createTransport, type Transporter } from "nodemailer";
import { abortedPromise, type Connector, type ConnectorContext, type InboundEvent } from "../connector.js";
import { ConnectorError } from "../../core/errors.js";
import { defineTool, type Tool } from "../../tools/tool.js";
import type { Logger } from "../../core/logger.js";

/**
 * Email connector: IMAP for reading + live inbox events, SMTP for sending.
 * Works with any standards-compliant provider (for Gmail/Workspace use an app
 * password). `email_send` is outward and routes through the approval policy.
 *
 * Connections are lazy — created on first use, shared across tools, and a
 * dedicated IMAP connection handles IDLE for inbound events.
 */

interface EmailConfig {
  imapHost?: string;
  imapPort: number;
  smtpHost?: string;
  smtpPort: number;
  user: string;
  password: string;
  from: string;
}

/** Factories are injectable for tests. */
export interface EmailTransports {
  imapFactory?: (opts: ImapFlowOptions) => ImapFlow;
  smtpFactory?: (opts: Record<string, unknown>) => Transporter;
}

export class EmailConnector implements Connector {
  readonly id = "email";
  private log!: Logger;
  private cfg!: EmailConfig;
  private toolsImap?: ImapFlow;
  private listenImap?: ImapFlow;
  private smtp?: Transporter;
  private readonly transports: Required<EmailTransports>;

  constructor(transports: EmailTransports = {}) {
    this.transports = {
      imapFactory: transports.imapFactory ?? ((opts) => new ImapFlow(opts)),
      smtpFactory: transports.smtpFactory ?? ((opts) => createTransport(opts as Parameters<typeof createTransport>[0])),
    };
  }

  async init(ctx: ConnectorContext): Promise<void> {
    this.log = ctx.log.child({ scope: "connector", connector: this.id });
    const { user, password, imapHost, smtpHost } = ctx.config;
    if (!user || !password) {
      throw new ConnectorError(this.id, "missing EMAIL_USER / EMAIL_PASSWORD");
    }
    if (!imapHost && !smtpHost) {
      throw new ConnectorError(this.id, "set EMAIL_IMAP_HOST (read) and/or EMAIL_SMTP_HOST (send)");
    }
    this.cfg = {
      imapHost,
      imapPort: Number(ctx.config.imapPort ?? 993),
      smtpHost,
      smtpPort: Number(ctx.config.smtpPort ?? 587),
      user,
      password,
      from: ctx.config.from ?? user,
    };
    this.log.info("email connector ready", {
      user,
      imap: imapHost ?? "(disabled)",
      smtp: smtpHost ?? "(disabled)",
    });
  }

  private async getToolsImap(): Promise<ImapFlow> {
    if (!this.cfg.imapHost) throw new ConnectorError(this.id, "EMAIL_IMAP_HOST is not configured");
    if (this.toolsImap?.usable) return this.toolsImap;
    this.toolsImap = await this.connectImap();
    return this.toolsImap;
  }

  private async connectImap(): Promise<ImapFlow> {
    const client = this.transports.imapFactory({
      host: this.cfg.imapHost!,
      port: this.cfg.imapPort,
      secure: this.cfg.imapPort === 993,
      auth: { user: this.cfg.user, pass: this.cfg.password },
      logger: false,
    });
    try {
      await client.connect();
    } catch (err) {
      throw new ConnectorError(this.id, `IMAP connect failed: ${(err as Error).message}`, {
        retryable: true,
        cause: err,
      });
    }
    return client;
  }

  private getSmtp(): Transporter {
    if (!this.cfg.smtpHost) throw new ConnectorError(this.id, "EMAIL_SMTP_HOST is not configured");
    if (!this.smtp) {
      this.smtp = this.transports.smtpFactory({
        host: this.cfg.smtpHost,
        port: this.cfg.smtpPort,
        secure: this.cfg.smtpPort === 465,
        auth: { user: this.cfg.user, pass: this.cfg.password },
      });
    }
    return this.smtp;
  }

  tools(): Tool[] {
    const listInbox = defineTool({
      name: "email_list_inbox",
      description: "List recent inbox messages (newest first) with their uid, sender, subject, and read state.",
      schema: z.object({
        limit: z.number().int().min(1).max(50).default(10),
        unreadOnly: z.boolean().default(false),
      }),
      execute: async (input) => {
        const client = await this.getToolsImap();
        const lock = await client.getMailboxLock("INBOX");
        try {
          let rows: FetchMessageObject[] = [];
          if (input.unreadOnly) {
            const uids = await client.search({ seen: false }, { uid: true });
            const recent = (uids || []).slice(-input.limit);
            for (const uid of recent) {
              const msg = await client.fetchOne(String(uid), { envelope: true, flags: true }, { uid: true });
              if (msg) rows.push(msg);
            }
          } else {
            const exists = client.mailbox && typeof client.mailbox === "object" ? client.mailbox.exists : 0;
            if (exists > 0) {
              const start = Math.max(1, exists - input.limit + 1);
              for await (const msg of client.fetch(`${start}:*`, { envelope: true, flags: true, uid: true })) {
                rows.push(msg);
              }
            }
          }
          rows = rows.sort((a, b) => b.uid - a.uid).slice(0, input.limit);
          if (rows.length === 0) return { content: input.unreadOnly ? "No unread messages." : "Inbox is empty." };
          return { content: rows.map((m) => renderEnvelopeRow(m)).join("\n") };
        } finally {
          lock.release();
        }
      },
    });

    const readMessage = defineTool({
      name: "email_read_message",
      description: "Read one email in full by its uid (from email_list_inbox or email_search).",
      schema: z.object({ uid: z.number().int().min(1) }),
      execute: async (input) => {
        const client = await this.getToolsImap();
        const lock = await client.getMailboxLock("INBOX");
        try {
          const msg = await client.fetchOne(String(input.uid), { source: true }, { uid: true });
          if (!msg || !msg.source) return { content: `No message with uid ${input.uid}.`, isError: true };
          const parsed = await simpleParser(msg.source);
          return { content: renderParsedMail(input.uid, parsed) };
        } finally {
          lock.release();
        }
      },
    });

    const searchMail = defineTool({
      name: "email_search",
      description: "Search the inbox by sender, subject, body text, and/or age. Returns matching messages, newest first.",
      schema: z.object({
        from: z.string().optional(),
        subject: z.string().optional(),
        text: z.string().optional().describe("Words that must appear in the body."),
        sinceDays: z.number().int().min(1).max(365).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      execute: async (input) => {
        if (!input.from && !input.subject && !input.text && !input.sinceDays) {
          return { content: "Give at least one of from / subject / text / sinceDays.", isError: true };
        }
        const client = await this.getToolsImap();
        const lock = await client.getMailboxLock("INBOX");
        try {
          const uids = await client.search(
            {
              ...(input.from ? { from: input.from } : {}),
              ...(input.subject ? { subject: input.subject } : {}),
              ...(input.text ? { body: input.text } : {}),
              ...(input.sinceDays ? { since: new Date(Date.now() - input.sinceDays * 86_400_000) } : {}),
            },
            { uid: true },
          );
          const recent = (uids || []).slice(-input.limit).reverse();
          if (recent.length === 0) return { content: "No matching messages." };
          const rows: string[] = [];
          for (const uid of recent) {
            const msg = await client.fetchOne(String(uid), { envelope: true, flags: true }, { uid: true });
            if (msg) rows.push(renderEnvelopeRow(msg));
          }
          return { content: rows.join("\n") };
        } finally {
          lock.release();
        }
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
        inReplyTo: z.string().optional().describe("messageId of the email being replied to."),
      }),
      execute: async (input) => {
        const info = await this.getSmtp().sendMail(buildMailOptions(this.cfg.from, input));
        return { content: `Sent "${input.subject}" to ${input.to.join(", ")} (id ${info.messageId ?? "?"}).` };
      },
    });

    return [listInbox, readMessage, searchMail, sendEmail];
  }

  /** IDLEs on INBOX over a dedicated connection; new mail becomes events. */
  async listen(onEvent: (event: InboundEvent) => void, signal: AbortSignal): Promise<void> {
    if (!this.cfg.imapHost) {
      this.log.warn("EMAIL_IMAP_HOST not set — email inbound events disabled (send still works)");
      return;
    }
    const client = await this.connectImap();
    this.listenImap = client;
    const mailbox = await client.mailboxOpen("INBOX");
    let lastSeen = mailbox.exists;
    this.log.info("email listening", { inbox: mailbox.exists });

    client.on("exists", (data) => {
      void (async () => {
        const from = lastSeen + 1;
        lastSeen = data.count;
        for (let seq = from; seq <= data.count; seq++) {
          try {
            const msg = await client.fetchOne(String(seq), { source: true, uid: true });
            if (!msg || !msg.source) continue;
            const parsed = await simpleParser(msg.source);
            const event = parsedMailToInbound(msg.uid, parsed, this.cfg.user);
            if (event) onEvent(event);
          } catch (err) {
            this.log.warn("failed to process incoming email", { seq, error: (err as Error).message });
          }
        }
      })();
    });

    await abortedPromise(signal);
    await client.logout().catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    await this.toolsImap?.logout().catch(() => undefined);
    await this.listenImap?.logout().catch(() => undefined);
    this.smtp?.close();
  }
}

export function renderEnvelopeRow(msg: FetchMessageObject): string {
  const env = msg.envelope;
  const from = (env?.from ?? []).map((a) => formatAddress(a)).join(", ") || "?";
  const unread = msg.flags && !msg.flags.has("\\Seen") ? " [unread]" : "";
  const date = env?.date ? new Date(env.date).toISOString() : "?";
  return `uid=${msg.uid}${unread} ${date} from ${from} — ${env?.subject ?? "(no subject)"}${env?.messageId ? ` messageId=${env.messageId}` : ""}`;
}

function formatAddress(addr: { name?: string; address?: string }): string {
  if (addr.name && addr.address) return `${addr.name} <${addr.address}>`;
  return addr.address ?? addr.name ?? "?";
}

export function renderParsedMail(uid: number, mail: ParsedMail): string {
  const body = (mail.text ?? stripHtml(typeof mail.html === "string" ? mail.html : "") ?? "").trim();
  return [
    `uid=${uid}`,
    `From: ${mail.from?.text ?? "?"}`,
    `To: ${addressText(mail.to)}`,
    mail.cc ? `Cc: ${addressText(mail.cc)}` : "",
    `Date: ${mail.date?.toISOString() ?? "?"}`,
    `Subject: ${mail.subject ?? "(no subject)"}`,
    mail.messageId ? `messageId: ${mail.messageId}` : "",
    mail.inReplyTo ? `inReplyTo: ${mail.inReplyTo}` : "",
    "",
    truncate(body || "(empty body)", 20_000),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function addressText(value: ParsedMail["to"]): string {
  if (!value) return "?";
  if (Array.isArray(value)) return value.map((v) => v.text).join(", ");
  return value.text;
}

export function buildMailOptions(
  from: string,
  input: { to: string[]; cc?: string[]; subject: string; body: string; inReplyTo?: string },
): Record<string, unknown> {
  return {
    from,
    to: input.to.join(", "),
    ...(input.cc && input.cc.length > 0 ? { cc: input.cc.join(", ") } : {}),
    subject: input.subject,
    text: input.body,
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo, references: input.inReplyTo } : {}),
  };
}

/** Maps a parsed inbound mail to an event; self-sent mail is suppressed. */
export function parsedMailToInbound(uid: number, mail: ParsedMail, selfAddress: string): InboundEvent | null {
  const fromAddress = mail.from?.value?.[0]?.address ?? "";
  if (fromAddress.toLowerCase() === selfAddress.toLowerCase()) return null;
  const references = Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [];
  const threadId = references[0] ?? mail.messageId ?? `uid:${uid}`;
  const snippet = (mail.text ?? "").trim().slice(0, 800);
  return {
    connector: "email",
    type: "email.received",
    eventId: mail.messageId ?? `uid:${uid}`,
    threadId,
    summary: [
      `Email from ${mail.from?.text ?? "?"} — "${mail.subject ?? "(no subject)"}" (uid=${uid}${mail.messageId ? `, messageId=${mail.messageId}` : ""}).`,
      `To reply in-thread, use email_send with inReplyTo="${mail.messageId ?? ""}".`,
      "",
      snippet,
    ].join("\n"),
    payload: { uid, subject: mail.subject, from: mail.from?.text, messageId: mail.messageId },
    receivedAt: new Date().toISOString(),
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
