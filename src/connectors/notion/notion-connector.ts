import { z } from "zod";
import type { Connector, ConnectorContext } from "../connector.js";
import { defineTool, type Tool } from "../../tools/tool.js";
import type { Logger } from "../../core/logger.js";

/** Notion connector stub. Wire up @notionhq/client behind these methods. */
export class NotionConnector implements Connector {
  readonly id = "notion";
  private log!: Logger;

  async init(ctx: ConnectorContext): Promise<void> {
    this.log = ctx.log.child({ scope: "connector", connector: this.id });
    this.log.info("notion connector initialized (stub)");
  }

  tools(): Tool[] {
    const search = defineTool({
      name: "notion_search",
      description: "Search Notion pages and databases the integration can access.",
      schema: z.object({ query: z.string(), limit: z.number().int().min(1).max(50).default(10) }),
      async execute(input) {
        return { content: `(stub) no Notion results for "${input.query}"` };
      },
    });

    const getPage = defineTool({
      name: "notion_get_page",
      description: "Fetch the content of a Notion page by id.",
      schema: z.object({ pageId: z.string() }),
      async execute(input) {
        return { content: `(stub) no content for page ${input.pageId}` };
      },
    });

    const updatePage = defineTool({
      name: "notion_append_block",
      description: "Append content to a Notion page. Acts outward; requires approval.",
      outward: true,
      schema: z.object({ pageId: z.string(), markdown: z.string() }),
      async execute(input, ctx) {
        ctx.log.info("notion_append_block (stub)", { pageId: input.pageId });
        return { content: `(stub) would append to page ${input.pageId}` };
      },
    });

    return [search, getPage, updatePage];
  }
}
