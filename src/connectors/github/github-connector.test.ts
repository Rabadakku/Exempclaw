import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubConnector } from "./github-connector.js";
import { fakeFetch } from "../../testing/fake-fetch.js";
import { quietLogger } from "../../testing/factories.js";
import type { Tool } from "../../tools/tool.js";

async function connector(routes: Parameters<typeof fakeFetch>[0], repos = "acme/app") {
  const fake = fakeFetch([{ match: "/user", reply: { login: "jordan-bot" } }, ...routes]);
  const gh = new GitHubConnector(fake.fetch);
  await gh.init({ log: quietLogger(), config: { token: "ghp_test", repos } });
  const tools = new Map(gh.tools().map((t) => [t.name, t]));
  return { gh, fake, tools };
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

const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `Issue ${n}`,
  state: "open",
  user: { login: "customer" },
  labels: [{ name: "bug" }],
  created_at: "2026-06-10T00:00:00Z",
  updated_at: "2026-06-11T00:00:00Z",
  html_url: `https://github.com/acme/app/issues/${n}`,
  ...extra,
});

test("init requires a token and validates repo format", async () => {
  const bare = new GitHubConnector(fakeFetch([]).fetch);
  await assert.rejects(() => bare.init({ log: quietLogger(), config: {} }), /GITHUB_TOKEN/);

  const bad = new GitHubConnector(fakeFetch([{ match: "/user", reply: { login: "x" } }]).fetch);
  await assert.rejects(
    () => bad.init({ log: quietLogger(), config: { token: "t", repos: "not-a-repo" } }),
    /invalid repo/,
  );
});

test("list issues filters PRs by default and uses the default repo", async () => {
  const { tools, fake } = await connector([
    { match: "/repos/acme/app/issues?", reply: [issue(1), issue(2, { pull_request: {} })] },
  ]);
  const result = await run(tools, "github_list_issues", { state: "open", limit: 20, includePullRequests: false });
  assert.match(result.content, /#1 \[open\] Issue 1/);
  assert.match(result.content, /\[bug\]/);
  assert.ok(!result.content.includes("#2"));
  assert.match(fake.to("/issues")[0]!.url, /repos\/acme\/app\/issues/);

  const withPrs = await run(tools, "github_list_issues", { state: "open", limit: 20, includePullRequests: true });
  assert.match(withPrs.content, /#2 \[open\] \[PR\]/);
});

test("read issue renders body and comments", async () => {
  const { tools } = await connector([
    { match: "/issues/7/comments", reply: [{ user: { login: "ana" }, body: "ping", created_at: "2026-06-11T01:00:00Z" }] },
    { match: "/issues/7", reply: issue(7, { body: "Something broke" }) },
  ]);
  const result = await run(tools, "github_read_issue", { number: 7 });
  assert.match(result.content, /#7 \[open\] Issue 7/);
  assert.match(result.content, /Something broke/);
  assert.match(result.content, /ana: ping/);
});

test("comment posts the body and suppresses the poll echo", async () => {
  const { gh, tools, fake } = await connector([
    { match: "/issues/7/comments", reply: { html_url: "https://github.com/acme/app/issues/7#c1" } },
  ]);
  const result = await run(tools, "github_comment", { number: 7, body: "On it." });
  assert.match(result.content, /#c1/);
  assert.deepEqual(fake.to("/comments")[0]!.body, { body: "On it." });
  assert.equal(gh.isRecentSelfAction("acme/app", 7), true);
  assert.equal(gh.isRecentSelfAction("acme/app", 8), false);
  // suppression expires after the echo window
  assert.equal(gh.isRecentSelfAction("acme/app", 7, Date.now() + 10 * 60_000), false);
});

test("create issue returns the new number and records self-action", async () => {
  const { gh, tools } = await connector([
    { match: "/repos/acme/app/issues", reply: { number: 99, html_url: "https://github.com/acme/app/issues/99" } },
  ]);
  const result = await run(tools, "github_create_issue", { title: "New", body: "", labels: [] });
  assert.match(result.content, /#99/);
  assert.equal(gh.isRecentSelfAction("acme/app", 99), true);
});

test("issueToInbound maps fresh vs updated and filters self/echoes", async () => {
  const { gh } = await connector([]);
  const since = "2026-06-11T00:00:00Z";

  const updated = gh.issueToInbound("acme/app", issue(1) as never, since);
  assert.ok(updated);
  assert.equal(updated.type, "github.issue_updated");
  assert.equal(updated.threadId, "acme/app#1");
  assert.equal(updated.eventId, "acme/app#1@2026-06-11T00:00:00Z");

  const fresh = gh.issueToInbound(
    "acme/app",
    issue(2, { created_at: "2026-06-11T05:00:00Z", body: "details" }) as never,
    since,
  );
  assert.ok(fresh);
  assert.equal(fresh.type, "github.issue_opened");
  assert.match(fresh.summary, /details/);

  // a fresh issue authored by the bot itself is ignored
  const own = gh.issueToInbound(
    "acme/app",
    issue(3, { created_at: "2026-06-11T05:00:00Z", user: { login: "jordan-bot" } }) as never,
    since,
  );
  assert.equal(own, null);
});

test("update issue closes/reopens and adds labels, recording the self-action", async () => {
  const { gh, tools, fake } = await connector([
    { match: "/issues/5/labels", reply: [] },
    { match: "/issues/5", reply: issue(5, { state: "closed" }) },
  ]);
  const result = await run(tools, "github_update_issue", { number: 5, state: "closed", addLabels: ["triaged"] });
  assert.match(result.content, /closed/);
  assert.match(result.content, /labeled \[triaged\]/);

  const patch = fake.requests.find((r) => r.method === "PATCH");
  assert.ok(patch);
  assert.deepEqual(patch.body, { state: "closed" });
  const labelPost = fake.to("/labels")[0]!;
  assert.deepEqual(labelPost.body, { labels: ["triaged"] });
  assert.equal(gh.isRecentSelfAction("acme/app", 5), true);
});

test("update issue requires a state or labels", async () => {
  const { tools } = await connector([]);
  const tool = [...tools.values()].find((t) => t.name === "github_update_issue")!;
  const parsed = tool.schema.safeParse({ number: 5, addLabels: [] });
  assert.equal(parsed.success, false);
});

test("tools fail clearly when no repo is configured or given", async () => {
  const fake = fakeFetch([{ match: "/user", reply: { login: "x" } }]);
  const gh = new GitHubConnector(fake.fetch);
  await gh.init({ log: quietLogger(), config: { token: "t" } });
  const tools = new Map(gh.tools().map((t) => [t.name, t]));
  await assert.rejects(
    () => run(tools, "github_list_issues", { state: "open", limit: 5, includePullRequests: false }),
    /GITHUB_REPOS/,
  );
});
