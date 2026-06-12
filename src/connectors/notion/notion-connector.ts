import { z } from "zod";
import type { Connector, ConnectorContext } from "../connector.js";
import { HttpJson, type FetchLike } from "../http.js";
import { ConnectorError } from "../../core/errors.js";
import { defineTool, type Tool } from "../../tools/tool.js";
import type { Logger } from "../../core/logger.js";

/**
 * Notion connector over the REST API (internal-integration token). Read tools
 * cover search and page content; write tools append to or create pages.
 * Notion has no push channel for internal integrations, so this connector
 * contributes no inbound events.
 *
 * Share the relevant pages/databases with the integration in Notion, or the
 * API will return empty results.
 */

const NOTION_VERSION = "2022-06-28";

interface RichText {
  plain_text?: string;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

interface SearchResult {
  id: string;
  object: "page" | "database";
  last_edited_time?: string;
  url?: string;
  properties?: Record<string, { type?: string; title?: RichText[] }>;
  title?: RichText[];
}

export class NotionConnector implements Connector {
  readonly id = "notion";
  private log!: Logger;
  private api!: HttpJson;

  constructor(private readonly fetchImpl?: FetchLike) {}

  async init(ctx: ConnectorContext): Promise<void> {
    this.log = ctx.log.child({ scope: "connector", connector: this.id });
    const token = ctx.config.token;
    if (!token) {
      throw new ConnectorError(this.id, "missing NOTION_TOKEN (internal integration secret, ntn_… or secret_…)");
    }
    this.api = new HttpJson({
      connector: this.id,
      baseUrl: "https://api.notion.com/v1",
      headers: { authorization: `Bearer ${token}`, "notion-version": NOTION_VERSION },
      fetchImpl: this.fetchImpl,
    });
    this.log.info("notion connector ready");
  }

  tools(): Tool[] {
    const search = defineTool({
      name: "notion_search",
      description: "Search Notion pages and databases the integration can access.",
      schema: z.object({
        query: z.string(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      execute: async (input, ctx) => {
        const res = await this.api.post<{ results: SearchResult[] }>("/search", {
          body: { query: input.query, page_size: input.limit },
          signal: ctx.signal,
        });
        if (res.results.length === 0) return { content: `No Notion results for "${input.query}".` };
        return {
          content: res.results
            .map((r) => `${r.object} ${r.id}  "${resultTitle(r)}"  (edited ${r.last_edited_time ?? "?"})`)
            .join("\n"),
        };
      },
    });

    const getPage = defineTool({
      name: "notion_get_page",
      description: "Fetch a Notion page's title and content as plain text. Accepts a page id or URL.",
      schema: z.object({ pageId: z.string() }),
      execute: async (input, ctx) => {
        const pageId = normalizePageId(input.pageId);
        if (!pageId) return { content: `"${input.pageId}" is not a Notion page id or URL.`, isError: true };
        const page = await this.api.get<SearchResult>(`/pages/${pageId}`, { signal: ctx.signal });

        const lines: string[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 3; i++) {
          const res = await this.api.get<{ results: NotionBlock[]; next_cursor?: string | null; has_more: boolean }>(
            `/blocks/${pageId}/children`,
            { query: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, signal: ctx.signal },
          );
          for (const block of res.results) lines.push(renderBlock(block));
          if (!res.has_more || !res.next_cursor) break;
          cursor = res.next_cursor;
        }
        return {
          content: [`# ${resultTitle(page)}`, page.url ?? "", "", ...lines.filter(Boolean)].join("\n"),
        };
      },
    });

    const appendBlock = defineTool({
      name: "notion_append_block",
      description:
        "Append markdown content to the end of a Notion page. Supports paragraphs, #/##/### headings, - bullets, 1. numbered lists, and > quotes. Acts outward; requires approval.",
      outward: true,
      schema: z.object({ pageId: z.string(), markdown: z.string().min(1) }),
      execute: async (input, ctx) => {
        const pageId = normalizePageId(input.pageId);
        if (!pageId) return { content: `"${input.pageId}" is not a Notion page id or URL.`, isError: true };
        const children = markdownToBlocks(input.markdown);
        await this.api.patch(`/blocks/${pageId}/children`, { body: { children }, signal: ctx.signal });
        return { content: `Appended ${children.length} block(s) to page ${pageId}.` };
      },
    });

    const createPage = defineTool({
      name: "notion_create_page",
      description: "Create a new Notion page under a parent page. Acts outward; requires approval.",
      outward: true,
      schema: z.object({
        parentPageId: z.string(),
        title: z.string().min(1),
        markdown: z.string().default(""),
      }),
      execute: async (input, ctx) => {
        const parent = normalizePageId(input.parentPageId);
        if (!parent) return { content: `"${input.parentPageId}" is not a Notion page id or URL.`, isError: true };
        const res = await this.api.post<{ id: string; url?: string }>("/pages", {
          body: {
            parent: { page_id: parent },
            properties: { title: { title: [{ type: "text", text: { content: input.title } }] } },
            ...(input.markdown ? { children: markdownToBlocks(input.markdown) } : {}),
          },
          signal: ctx.signal,
        });
        return { content: `Created page ${res.id}${res.url ? ` (${res.url})` : ""}.` };
      },
    });

    return [search, getPage, appendBlock, createPage];
  }
}

/** Accepts dashed/undashed UUIDs or a Notion URL; returns a dashed UUID. */
export function normalizePageId(input: string): string | null {
  const match = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})/i.exec(
    input.trim(),
  );
  if (!match) return null;
  return [match[1], match[2], match[3], match[4], match[5]].join("-").toLowerCase();
}

export function resultTitle(result: SearchResult): string {
  if (result.title?.length) return joinRichText(result.title);
  for (const prop of Object.values(result.properties ?? {})) {
    if (prop.type === "title" && prop.title) return joinRichText(prop.title);
  }
  return "(untitled)";
}

function joinRichText(rich: RichText[]): string {
  return rich.map((r) => r.plain_text ?? "").join("") || "(untitled)";
}

/** Renders one block to a plain-text line. Unknown types become markers. */
export function renderBlock(block: NotionBlock): string {
  const data = block[block.type] as { rich_text?: RichText[]; title?: string; checked?: boolean } | undefined;
  const text = data?.rich_text ? joinRichTextLoose(data.rich_text) : "";
  switch (block.type) {
    case "paragraph":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${data?.checked ? "x" : " "}] ${text}`;
    case "quote":
      return `> ${text}`;
    case "code":
      return `\`\`\`\n${text}\n\`\`\``;
    case "callout":
    case "toggle":
      return text;
    case "child_page":
      return `[subpage: ${data?.title ?? block.id}]`;
    case "divider":
      return "---";
    default:
      return text ? text : `[${block.type}]`;
  }
}

function joinRichTextLoose(rich: RichText[]): string {
  return rich.map((r) => r.plain_text ?? "").join("");
}

interface ParagraphBlock {
  object: "block";
  type: string;
  [key: string]: unknown;
}

/** Converts simple markdown into Notion block objects. */
export function markdownToBlocks(markdown: string): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith("### ")) blocks.push(textBlock("heading_3", line.slice(4)));
    else if (line.startsWith("## ")) blocks.push(textBlock("heading_2", line.slice(3)));
    else if (line.startsWith("# ")) blocks.push(textBlock("heading_1", line.slice(2)));
    else if (line.startsWith("- ") || line.startsWith("* ")) blocks.push(textBlock("bulleted_list_item", line.slice(2)));
    else if (/^\d+\.\s/.test(line)) blocks.push(textBlock("numbered_list_item", line.replace(/^\d+\.\s/, "")));
    else if (line.startsWith("> ")) blocks.push(textBlock("quote", line.slice(2)));
    else blocks.push(textBlock("paragraph", line));
  }
  return blocks;
}

function textBlock(type: string, content: string): ParagraphBlock {
  return {
    object: "block",
    type,
    [type]: {
      // Notion caps a single rich_text item at 2000 chars.
      rich_text: chunkString(content, 2000).map((part) => ({ type: "text", text: { content: part } })),
    },
  };
}

function chunkString(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}
