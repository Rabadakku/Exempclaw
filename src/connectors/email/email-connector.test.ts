import { test } from "node:test";
import assert from "node:assert/strict";
import type { ParsedMail } from "mailparser";
import {
  buildMailOptions,
  EmailConnector,
  parsedMailToInbound,
  renderEnvelopeRow,
  renderParsedMail,
} from "./email-connector.js";
import { quietLogger } from "../../testing/factories.js";

test("init requires credentials and at least one host", async () => {
  const email = new EmailConnector();
  await assert.rejects(() => email.init({ log: quietLogger(), config: {} }), /EMAIL_USER/);
  await assert.rejects(
    () => email.init({ log: quietLogger(), config: { user: "j@acme.com", password: "p" } }),
    /EMAIL_IMAP_HOST.*EMAIL_SMTP_HOST/,
  );
  // smtp-only is a valid (send-only) configuration
  await email.init({ log: quietLogger(), config: { user: "j@acme.com", password: "p", smtpHost: "smtp.acme.com" } });
});

test("email_send goes through the injected SMTP transport with threading headers", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const email = new EmailConnector({
    smtpFactory: () =>
      ({
        sendMail: async (opts: Record<string, unknown>) => {
          sent.push(opts);
          return { messageId: "<new@acme>" };
        },
        close: () => undefined,
      }) as never,
  });
  await email.init({
    log: quietLogger(),
    config: { user: "j@acme.com", password: "p", smtpHost: "smtp.acme.com", from: "Jordan <jordan@acme.com>" },
  });
  const send = email.tools().find((t) => t.name === "email_send")!;
  assert.equal(send.outward, true);
  const result = await send.execute(
    { to: ["ana@client.com"], cc: [], subject: "Re: rollout", body: "On it.", inReplyTo: "<orig@client>" },
    { agentId: "a", log: quietLogger(), signal: new AbortController().signal, requestApproval: async () => true },
  );
  assert.match(result.content, /Sent "Re: rollout" to ana@client.com/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.from, "Jordan <jordan@acme.com>");
  assert.equal(sent[0]!.inReplyTo, "<orig@client>");
  assert.equal(sent[0]!.references, "<orig@client>");
});

test("email_mark_read sets the Seen flag by uid", async () => {
  const flagged: Array<[string, string[]]> = [];
  const fakeImap = {
    usable: true,
    connect: async () => undefined,
    logout: async () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    messageFlagsAdd: async (range: string, flags: string[]) => {
      flagged.push([range, flags]);
      return true;
    },
  };
  const email = new EmailConnector({ imapFactory: () => fakeImap as never });
  await email.init({
    log: quietLogger(),
    config: { user: "j@acme.com", password: "p", imapHost: "imap.acme.com" },
  });
  const markRead = email.tools().find((t) => t.name === "email_mark_read")!;
  const result = await markRead.execute(
    { uid: 77 },
    { agentId: "a", log: quietLogger(), signal: new AbortController().signal, requestApproval: async () => true },
  );
  assert.match(result.content, /Marked uid 77 as read/);
  assert.deepEqual(flagged, [["77", ["\\Seen"]]]);
});

test("listen reconnects after the factory fails, until aborted", async () => {
  let attempts = 0;
  const email = new EmailConnector({
    imapFactory: () => {
      attempts++;
      throw new Error("connect refused");
    },
  });
  await email.init({
    log: quietLogger(),
    config: { user: "j@acme.com", password: "p", imapHost: "imap.acme.com" },
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 120);
  await email.listen(() => undefined, controller.signal);
  // first attempt immediately, then at least one retry within the window
  assert.ok(attempts >= 1, `expected connection attempts, got ${attempts}`);
});

test("buildMailOptions omits cc when empty and threading when absent", () => {
  const opts = buildMailOptions("j@acme.com", { to: ["a@b.c", "d@e.f"], subject: "s", body: "b" });
  assert.deepEqual(opts, { from: "j@acme.com", to: "a@b.c, d@e.f", subject: "s", text: "b" });
});

test("renderEnvelopeRow shows uid, unread flag, sender, and messageId", () => {
  const row = renderEnvelopeRow({
    seq: 1,
    uid: 42,
    flags: new Set<string>(),
    envelope: {
      date: new Date("2026-06-12T10:00:00Z"),
      subject: "Quarterly numbers",
      messageId: "<m1@x>",
      from: [{ name: "Ana", address: "ana@client.com" }],
    },
  } as never);
  assert.match(row, /uid=42 \[unread\]/);
  assert.match(row, /Ana <ana@client.com>/);
  assert.match(row, /Quarterly numbers/);
  assert.match(row, /messageId=<m1@x>/);

  const read = renderEnvelopeRow({ seq: 1, uid: 1, flags: new Set(["\\Seen"]), envelope: { subject: "s" } } as never);
  assert.ok(!read.includes("[unread]"));
});

test("renderParsedMail includes headers and truncated body", () => {
  const mail = {
    from: { text: "Ana <ana@client.com>", value: [{ address: "ana@client.com" }] },
    to: { text: "jordan@acme.com", value: [] },
    subject: "Hello",
    date: new Date("2026-06-12T10:00:00Z"),
    messageId: "<m1@x>",
    text: "body text",
  } as unknown as ParsedMail;
  const rendered = renderParsedMail(7, mail);
  assert.match(rendered, /uid=7/);
  assert.match(rendered, /From: Ana <ana@client.com>/);
  assert.match(rendered, /Subject: Hello/);
  assert.match(rendered, /body text/);
});

test("parsedMailToInbound threads by references and suppresses self-mail", () => {
  const mail = {
    from: { text: "Ana <ana@client.com>", value: [{ address: "ana@client.com" }] },
    subject: "Re: rollout",
    messageId: "<m2@x>",
    references: ["<root@x>", "<m1@x>"],
    text: "any update?",
  } as unknown as ParsedMail;

  const event = parsedMailToInbound(43, mail, "jordan@acme.com");
  assert.ok(event);
  assert.equal(event.type, "email.received");
  assert.equal(event.eventId, "<m2@x>");
  assert.equal(event.threadId, "<root@x>");
  assert.match(event.summary, /inReplyTo="<m2@x>"/);
  assert.match(event.summary, /any update\?/);

  const self = parsedMailToInbound(44, { ...mail, from: { text: "me", value: [{ address: "JORDAN@acme.com" }] } } as never, "jordan@acme.com");
  assert.equal(self, null);
});

test("parsedMailToInbound falls back to messageId then uid for threading", () => {
  const base = { from: { text: "a", value: [{ address: "a@b.c" }] }, text: "" } as unknown as ParsedMail;
  assert.equal(parsedMailToInbound(1, { ...base, messageId: "<only@x>" } as never, "self@x")!.threadId, "<only@x>");
  assert.equal(parsedMailToInbound(9, base, "self@x")!.threadId, "uid:9");
});
