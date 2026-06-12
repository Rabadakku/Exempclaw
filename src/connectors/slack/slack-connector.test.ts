import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSocketMessage, slackEventToInbound, SlackConnector } from "./slack-connector.js";
import { fakeFetch } from "../../testing/fake-fetch.js";
import { quietLogger } from "../../testing/factories.js";
import type { Tool } from "../../tools/tool.js";

const AUTH_OK = { ok: true, user_id: "USELF", user: "jordan-bot", team: "acme" };

async function connector(routes: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch([{ match: "auth.test", reply: AUTH_OK }, ...routes]);
  const slack = new SlackConnector(fake.fetch);
  await slack.init({ log: quietLogger(), config: { botToken: "xoxb-test" } });
  const tools = new Map(slack.tools().map((t) => [t.name, t]));
  return { slack, fake, tools };
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

test("init fails fast without a bot token", async () => {
  const slack = new SlackConnector(fakeFetch([]).fetch);
  await assert.rejects(() => slack.init({ log: quietLogger(), config: {} }), /SLACK_BOT_TOKEN/);
});

test("init verifies auth and records the bot user", async () => {
  const { fake } = await connector([]);
  assert.equal(fake.to("auth.test").length, 1);
  assert.equal(fake.to("auth.test")[0]!.headers.authorization, "Bearer xoxb-test");
});

test("slack API errors surface as ConnectorError", async () => {
  const { tools } = await connector([{ match: "conversations.history", reply: { ok: false, error: "channel_not_found" } }]);
  await assert.rejects(() => run(tools, "slack_read_channel", { channel: "C123ABCDEF" }), /channel_not_found/);
});

test("read channel renders messages oldest-first with user names", async () => {
  const { tools } = await connector([
    {
      match: "conversations.history",
      reply: {
        ok: true,
        messages: [
          { type: "message", user: "U2", text: "second", ts: "2.0" },
          { type: "message", user: "U1", text: "first", ts: "1.0", reply_count: 2 },
        ],
      },
    },
    { match: "users.info", reply: { ok: true, user: { name: "ana", profile: { display_name: "Ana" } } } },
  ]);
  const result = await run(tools, "slack_read_channel", { channel: "C123ABCDEF", limit: 10 });
  const lines = result.content.split("\n");
  assert.match(lines[0]!, /channel=C123ABCDEF/);
  assert.match(lines[1]!, /first/);
  assert.match(lines[1]!, /thread with 2 replies/);
  assert.match(lines[2]!, /second/);
  assert.match(lines[1]!, /Ana/);
});

test("post message resolves #names via conversations.list and sends thread_ts", async () => {
  const { tools, fake } = await connector([
    {
      match: "conversations.list",
      reply: { ok: true, channels: [{ id: "C42", name: "support" }] },
    },
    { match: "chat.postMessage", reply: { ok: true, ts: "9.9", channel: "C42" } },
  ]);
  const result = await run(tools, "slack_post_message", { channel: "#support", text: "hello", threadTs: "1.0" });
  assert.match(result.content, /C42/);
  const post = fake.to("chat.postMessage")[0]!;
  assert.deepEqual(post.body, { channel: "C42", text: "hello", thread_ts: "1.0" });
});

test("unknown channel name is a clear error", async () => {
  const { tools } = await connector([{ match: "conversations.list", reply: { ok: true, channels: [] } }]);
  await assert.rejects(() => run(tools, "slack_read_channel", { channel: "#ghost" }), /channel not found/);
});

test("parseSocketMessage classifies hello / disconnect / events / junk", () => {
  assert.equal(parseSocketMessage('{"type":"hello"}').kind, "hello");
  assert.deepEqual(parseSocketMessage('{"type":"disconnect","reason":"refresh"}'), {
    kind: "disconnect",
    reason: "refresh",
  });
  const event = parseSocketMessage(
    JSON.stringify({
      type: "events_api",
      envelope_id: "env-1",
      payload: { event_id: "Ev1", event: { type: "app_mention", user: "U1", text: "hi", channel: "C1", ts: "1.0" } },
    }),
  );
  assert.equal(event.kind, "event");
  if (event.kind === "event") {
    assert.equal(event.envelopeId, "env-1");
    assert.equal(event.eventId, "Ev1");
  }
  assert.equal(parseSocketMessage("not json").kind, "other");
  assert.equal(parseSocketMessage('{"type":"interactive"}').kind, "other");
});

test("slackEventToInbound maps mentions and DMs, filters noise", () => {
  const mention = slackEventToInbound(
    "Ev1",
    { type: "app_mention", user: "U1", text: "help", channel: "C1", ts: "5.0", thread_ts: "1.0" },
    "USELF",
  );
  assert.ok(mention);
  assert.equal(mention.type, "slack.mention");
  assert.equal(mention.threadId, "C1:1.0");
  assert.match(mention.summary, /threadTs="1.0"/);

  const dm = slackEventToInbound("Ev2", { type: "message", channel_type: "im", user: "U1", text: "hi", channel: "D1", ts: "2.0" }, "USELF");
  assert.ok(dm);
  assert.equal(dm.type, "slack.dm");

  // self, bots, subtypes, and ordinary channel chatter are ignored
  assert.equal(slackEventToInbound("E", { type: "app_mention", user: "USELF", channel: "C1", ts: "1" }, "USELF"), null);
  assert.equal(slackEventToInbound("E", { type: "message", bot_id: "B1", channel_type: "im", channel: "D1", ts: "1" }, "USELF"), null);
  assert.equal(
    slackEventToInbound("E", { type: "message", subtype: "message_changed", user: "U1", channel_type: "im", channel: "D1", ts: "1" }, "USELF"),
    null,
  );
  assert.equal(slackEventToInbound("E", { type: "message", user: "U1", channel_type: "channel", channel: "C1", ts: "1" }, "USELF"), null);
});
