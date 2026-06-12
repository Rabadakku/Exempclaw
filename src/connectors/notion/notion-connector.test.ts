import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToBlocks, normalizePageId, NotionConnector, renderBlock } from "./notion-connector.js";
import { fakeFetch } from "../../testing/fake-fetch.js";
import { quietLogger } from "../../testing/factories.js";
import type { Tool } from "../../tools/tool.js";

const PAGE_ID = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";

async function connector(routes: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(routes);
  const notion = new NotionConnector(fake.fetch);
  await notion.init({ log: quietLogger(), config: { token: "ntn_test" } });
  const tools = new Map(notion.tools().map((t) => [t.name, t]));
  return { notion, fake, tools };
}

const ctx = {
  agentId: "a1",
  log: quietLogger(),
  signal: new AbortController().signal,
  requestApproval: async () => true,
};

function run(tools: Map<string, Tool>, name: string, input: unknown) {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} missing`);
  return tool.execute(input, ctx);
}

test("normalizePageId accepts dashed, undashed, and URL forms", () => {
  assert.equal(normalizePageId(PAGE_ID), PAGE_ID);
  assert.equal(normalizePageId(PAGE_ID.replaceAll("-", "")), PAGE_ID);
  assert.equal(normalizePageId(`https://www.notion.so/acme/Runbook-${PAGE_ID.replaceAll("-", "")}`), PAGE_ID);
  assert.equal(normalizePageId("definitely not an id"), null);
});

test("search renders titles from pages and databases", async () => {
  const { tools, fake } = await connector([
    {
      match: "/search",
      reply: {
        results: [
          {
            id: "p1",
            object: "page",
            last_edited_time: "2026-06-01",
            properties: { Name: { type: "title", title: [{ plain_text: "Support Runbook" }] } },
          },
          { id: "d1", object: "database", title: [{ plain_text: "Tickets" }] },
        ],
      },
    },
  ]);
  const result = await run(tools, "notion_search", { query: "runbook", limit: 10 });
  assert.match(result.content, /page p1\s+"Support Runbook"/);
  assert.match(result.content, /database d1\s+"Tickets"/);
  assert.deepEqual(fake.to("/search")[0]!.body, { query: "runbook", page_size: 10 });
});

test("get page joins title and rendered blocks", async () => {
  const { tools } = await connector([
    {
      match: `/pages/${PAGE_ID}`,
      reply: { id: PAGE_ID, object: "page", properties: { title: { type: "title", title: [{ plain_text: "Runbook" }] } } },
    },
    {
      match: `/blocks/${PAGE_ID}/children`,
      reply: {
        has_more: false,
        results: [
          { id: "b1", type: "heading_2", heading_2: { rich_text: [{ plain_text: "Escalation" }] } },
          { id: "b2", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Call Ana." }] } },
          { id: "b3", type: "to_do", to_do: { rich_text: [{ plain_text: "rotate creds" }], checked: true } },
        ],
      },
    },
  ]);
  const result = await run(tools, "notion_get_page", { pageId: PAGE_ID.replaceAll("-", "") });
  assert.match(result.content, /# Runbook/);
  assert.match(result.content, /## Escalation/);
  assert.match(result.content, /Call Ana\./);
  assert.match(result.content, /- \[x\] rotate creds/);
});

test("append converts markdown and PATCHes children", async () => {
  const { tools, fake } = await connector([{ match: `/blocks/${PAGE_ID}/children`, reply: {} }]);
  const result = await run(tools, "notion_append_block", {
    pageId: PAGE_ID,
    markdown: "## Update\nShipped the fix.\n- item one\n",
  });
  assert.match(result.content, /Appended 3 block/);
  const req = fake.to("/children")[0]!;
  assert.equal(req.method, "PATCH");
  const children = (req.body as { children: Array<{ type: string }> }).children;
  assert.deepEqual(children.map((c) => c.type), ["heading_2", "paragraph", "bulleted_list_item"]);
});

test("bad page ids are tool errors, not requests", async () => {
  const { tools, fake } = await connector([]);
  const result = await run(tools, "notion_get_page", { pageId: "nope" });
  assert.equal(result.isError, true);
  assert.equal(fake.requests.length, 0);
});

test("markdownToBlocks handles every supported prefix and skips blanks", () => {
  const blocks = markdownToBlocks("# H1\n## H2\n### H3\n\n- bullet\n* star\n1. first\n> quoted\nplain");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading_1", "heading_2", "heading_3", "bulleted_list_item", "bulleted_list_item", "numbered_list_item", "quote", "paragraph"],
  );
});

test("markdownToBlocks chunks rich_text at Notion's 2000-char cap", () => {
  const long = "x".repeat(4500);
  const blocks = markdownToBlocks(long);
  const richText = (blocks[0] as unknown as { paragraph: { rich_text: Array<{ text: { content: string } }> } })
    .paragraph.rich_text;
  assert.equal(richText.length, 3);
  assert.equal(richText[0]!.text.content.length, 2000);
});

test("renderBlock covers common block types", () => {
  assert.equal(renderBlock({ id: "1", type: "divider" }), "---");
  assert.equal(
    renderBlock({ id: "2", type: "child_page", child_page: { title: "Sub" } } as never),
    "[subpage: Sub]",
  );
  assert.equal(renderBlock({ id: "3", type: "weird_embed" }), "[weird_embed]");
});
