import { z } from "zod";
import type { Connector, ConnectorContext, InboundEvent } from "../connector.js";
import { defineTool, type Tool } from "../../tools/tool.js";
import type { Logger } from "../../core/logger.js";

/**
 * Email connector — the worked example of the connector pattern.
 *
 * This is a structural stub: the tool surface and event shape are real, but the
 * IMAP/SMTP plumbing is marked TODO. Drop in a library (e.g. `imapflow` +
 * `nodemailer`) behind these methods and the agent runtime needs no changes.
 *
 * `send_email` is declared `outward: true`, so it routes through the approval
 * policy before anything leaves the building.
 */
export class EmailConnector implements Connector {
  readonly id = "email";
  private log!: Logger;
  private config!: Record<string, string>;

  async init(ctx: ConnectorContext): Promise<void> {
    this.log = ctx.log.child({ scope: "connector", connector: this.id });
    this.config = ctx.config;
    // TODO: open the IMAP connection + verify SMTP transport here.
    this.log.info("email connector initialized (stub)", { user: this.config.user ?? "<unset>" });
  }

  tools(): Tool[] {
    const readInbox = defineTool({
      name: "email_read_inbox",
      description: "List recent messages in the inbox (most recent first).",
      schema: z.object({
        limit: z.number().int().min(1).max(50).default(10),
        unreadOnly: z.boolean().default(false),
      }),
      async execute() {
        // TODO: fetch via IMAP. Returning a placeholder keeps the loop testable.
        return { content: "[]  (email_read_inbox is a stub — wire up IMAP to return real messages)" };
      },
    });

    const readThread = defineTool({
      name: "email_read_thread",
      description: "Read the full message history of an email thread by its id.",
      schema: z.object({ threadId: z.string() }),
      async execute(input) {
        return { content: `(stub) no messages for thread ${input.threadId}` };
      },
    });

    const sendEmail = defineTool({
      name: "email_send",
      description:
        "Send an email. This acts on the outside world and requires approval under the configured policy.",
      outward: true,
      schema: z.object({
        to: z.array(z.string()).min(1),
        subject: z.string(),
        body: z.string(),
        inReplyTo: z.string().optional().describe("Thread id to reply within, if any."),
      }),
      async execute(input, ctx) {
        // TODO: send via SMTP. Until then, log the intent so flows are observable.
        ctx.log.info("email_send (stub)", { to: input.to.join(","), subject: input.subject });
        return { content: `(stub) would send "${input.subject}" to ${input.to.join(", ")}` };
      },
    });

    return [readInbox, readThread, sendEmail];
  }

  async listen(onEvent: (event: InboundEvent) => void, signal: AbortSignal): Promise<void> {
    // TODO: subscribe to IMAP IDLE and translate each new message into an
    // InboundEvent. The no-op below resolves immediately so the orchestrator
    // can start without a real mailbox.
    void onEvent;
    void signal;
    this.log.debug("email listen() is a stub — no inbound events will fire");
  }

  async shutdown(): Promise<void> {
    // TODO: close IMAP/SMTP connections.
  }
}
