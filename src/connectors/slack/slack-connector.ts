import { z } from "zod";
import type { Connector, ConnectorContext, InboundEvent } from "../connector.js";
import { defineTool, type Tool } from "../../tools/tool.js";
import type { Logger } from "../../core/logger.js";

/** Slack connector stub. Wire up @slack/web-api + socket mode behind these methods. */
export class SlackConnector implements Connector {
  readonly id = "slack";
  private log!: Logger;

  async init(ctx: ConnectorContext): Promise<void> {
    this.log = ctx.log.child({ scope: "connector", connector: this.id });
    this.log.info("slack connector initialized (stub)");
  }

  tools(): Tool[] {
    const readChannel = defineTool({
      name: "slack_read_channel",
      description: "Read recent messages from a Slack channel.",
      schema: z.object({ channel: z.string(), limit: z.number().int().min(1).max(100).default(20) }),
      async execute(input) {
        return { content: `(stub) no messages for #${input.channel}` };
      },
    });

    const postMessage = defineTool({
      name: "slack_post_message",
      description: "Post a message to a Slack channel or thread. Acts outward; requires approval.",
      outward: true,
      schema: z.object({ channel: z.string(), text: z.string(), threadTs: z.string().optional() }),
      async execute(input, ctx) {
        ctx.log.info("slack_post_message (stub)", { channel: input.channel });
        return { content: `(stub) would post to #${input.channel}` };
      },
    });

    return [readChannel, postMessage];
  }

  async listen(onEvent: (event: InboundEvent) => void, signal: AbortSignal): Promise<void> {
    void onEvent;
    void signal;
    this.log.debug("slack listen() is a stub");
  }
}
