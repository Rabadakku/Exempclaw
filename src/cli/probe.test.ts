import { test } from "node:test";
import assert from "node:assert/strict";
import { probeGitHub, probeNotion, probeSlack, probeEmail } from "./probe.js";
import { fakeFetch } from "../testing/fake-fetch.js";

test("probeSlack reports team and socket-mode readiness", async () => {
  const fake = fakeFetch([
    { match: "auth.test", reply: { ok: true, team: "acme", user: "jordan-bot" } },
    { match: "apps.connections.open", reply: { ok: true, url: "wss://x" } },
  ]);
  const result = await probeSlack({ botToken: "xoxb", appToken: "xapp" }, fake.fetch);
  assert.equal(result.ok, true);
  assert.match(result.detail, /jordan-bot @ acme/);
  assert.match(result.detail, /socket mode ready/);
});

test("probeSlack flags a bad app token even when the bot token works", async () => {
  const fake = fakeFetch([
    { match: "auth.test", reply: { ok: true, team: "acme", user: "bot" } },
    { match: "apps.connections.open", reply: { ok: false, error: "invalid_auth" } },
  ]);
  const result = await probeSlack({ botToken: "xoxb", appToken: "xapp" }, fake.fetch);
  assert.equal(result.ok, false);
  assert.match(result.detail, /invalid_auth/);
});

test("probeSlack notes when events are off (no app token)", async () => {
  const fake = fakeFetch([{ match: "auth.test", reply: { ok: true, team: "acme", user: "bot" } }]);
  const result = await probeSlack({ botToken: "xoxb" }, fake.fetch);
  assert.equal(result.ok, true);
  assert.match(result.detail, /events off/);
});

test("probeNotion reads the integration identity", async () => {
  const fake = fakeFetch([
    { match: "/users/me", reply: { name: "Exempclaw", bot: { workspace_name: "Acme HQ" } } },
  ]);
  const result = await probeNotion({ token: "ntn" }, fake.fetch);
  assert.equal(result.ok, true);
  assert.match(result.detail, /Exempclaw.*Acme HQ/);
});

test("probeNotion surfaces auth failures", async () => {
  const fake = fakeFetch([{ match: "/users/me", reply: { message: "unauthorized" }, status: 401 }]);
  const result = await probeNotion({ token: "bad" }, fake.fetch);
  assert.equal(result.ok, false);
  assert.match(result.detail, /401/);
});

test("probeGitHub verifies identity and each configured repo", async () => {
  const fake = fakeFetch([
    { match: "/user", reply: { login: "jordan-bot" } },
    { match: "/repos/acme/app", reply: { full_name: "acme/app" } },
    { match: "/repos/acme/missing", reply: { message: "Not Found" }, status: 404 },
  ]);
  const okResult = await probeGitHub({ token: "t", repos: "acme/app" }, fake.fetch);
  assert.equal(okResult.ok, true);
  assert.match(okResult.detail, /as jordan-bot · 1 repo/);

  const badResult = await probeGitHub({ token: "t", repos: "acme/app,acme/missing" }, fake.fetch);
  assert.equal(badResult.ok, false);
  assert.match(badResult.detail, /cannot reach: acme\/missing/);
});

test("probeEmail verifies imap and smtp through injected transports", async () => {
  const result = await probeEmail(
    { user: "j@a.com", password: "p", imapHost: "imap.a.com", smtpHost: "smtp.a.com" },
    {
      imapFactory: () =>
        ({
          connect: async () => undefined,
          logout: async () => undefined,
        }) as never,
      smtpFactory: (() =>
        ({
          verify: async () => true,
          close: () => undefined,
        }) as never) as never,
    },
  );
  assert.equal(result.ok, true);
  assert.match(result.detail, /imap imap.a.com ok · smtp smtp.a.com ok/);
});

test("probeEmail reports the failing leg", async () => {
  const result = await probeEmail(
    { user: "j@a.com", password: "p", imapHost: "imap.a.com" },
    {
      imapFactory: () =>
        ({
          connect: async () => {
            throw new Error("ECONNREFUSED");
          },
          logout: async () => undefined,
        }) as never,
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /ECONNREFUSED/);
});
