/**
 * The fictional workspace behind demo mode: a small, consistent Initech
 * support universe. The demo connector's tools read and write this world, so
 * the experience (uids, messageIds, thread replies) looks exactly like the
 * real connectors — but nothing leaves the process.
 */

export interface DemoEmail {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  messageId: string;
  body: string;
  seen: boolean;
}

export interface DemoSlackMessage {
  user: string;
  text: string;
  ts: string;
  threadTs?: string;
}

export interface DemoSlackChannel {
  id: string;
  name: string;
  messages: DemoSlackMessage[];
}

export interface SentEmail {
  to: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  at: string;
}

export class DemoWorld {
  readonly emails: DemoEmail[] = [
    {
      uid: 4709,
      from: "Marcus Webb <marcus@acme.example>",
      to: "support@acme.example",
      subject: "FYI — Initech renewal kickoff in September",
      date: "2026-06-10T15:20:00Z",
      messageId: "<m-4709@acme.example>",
      body:
        "Heads up: Initech's finance team starts the renewal conversation in early September. " +
        "Ana hinted they'll push for volume pricing. Let's have the one-pager ready before then.\n\n— Marcus",
      seen: true,
    },
    {
      uid: 4710,
      from: "StatusBot <alerts@acme.example>",
      to: "support@acme.example",
      subject: "[resolved] elevated webhook retry latency",
      date: "2026-06-11T22:41:00Z",
      messageId: "<m-4710@acme.example>",
      body: "The staging fix for webhook retry drops deployed cleanly at 22:30 UTC. Error rate back to baseline.",
      seen: true,
    },
    {
      uid: 4711,
      from: "Ana Flores <ana.flores@initech.example>",
      to: "support@acme.example",
      subject: "Re: webhook retries dropping events",
      date: "2026-06-12T06:55:00Z",
      messageId: "<m-4711@initech.example>",
      body:
        "Morning — we ran our soak test against staging overnight and the dropped-event rate is zero. " +
        "Looks like your fix holds. Two asks:\n\n" +
        "1. When does it land in production? Our finance close runs on these webhooks.\n" +
        "2. Could you send the volume-pricing one-pager before our renewal kickoff in September?\n\nThanks,\nAna",
      seen: false,
    },
  ];

  readonly channels: DemoSlackChannel[] = [
    {
      id: "C0DEMO1",
      name: "support",
      messages: [
        { user: "priya", text: "Quiet night — two password resets, both self-served.", ts: "1765531200.000100" },
        {
          user: "marcus",
          text: "If Ana confirms the staging fix, let's get the prod date locked today.",
          ts: "1765537200.000200",
        },
      ],
    },
    {
      id: "C0DEMO2",
      name: "initech-account",
      messages: [
        {
          user: "marcus",
          text: "Renewal kickoff is September. Volume pricing one-pager is the ask — drafting with finance.",
          ts: "1765520000.000300",
        },
        {
          user: "engineering-bot",
          text: "webhook-retry fix: staging soak PASSED (0 drops / 48h). Prod rollout proposed for Thursday.",
          ts: "1765540000.000400",
        },
      ],
    },
  ];

  readonly sentEmails: SentEmail[] = [];
  readonly postedMessages: Array<{ channel: string; text: string; threadTs?: string; ts: string }> = [];
  private nextTs = 1765550000;

  findEmail(uid: number): DemoEmail | undefined {
    return this.emails.find((e) => e.uid === uid);
  }

  searchEmails(query: { from?: string; subject?: string; text?: string }): DemoEmail[] {
    const norm = (s: string) => s.toLowerCase();
    return this.emails.filter((e) => {
      if (query.from && !norm(e.from).includes(norm(query.from))) return false;
      if (query.subject && !norm(e.subject).includes(norm(query.subject))) return false;
      if (query.text && !norm(e.body).includes(norm(query.text))) return false;
      return true;
    });
  }

  findChannel(ref: string): DemoSlackChannel | undefined {
    const name = ref.replace(/^#/, "").toLowerCase();
    return this.channels.find((c) => c.id === ref || c.name === name);
  }

  sendEmail(mail: Omit<SentEmail, "at">): SentEmail {
    const sent: SentEmail = { ...mail, at: new Date().toISOString() };
    this.sentEmails.push(sent);
    return sent;
  }

  postMessage(channel: DemoSlackChannel, text: string, threadTs?: string): string {
    const ts = `${this.nextTs++}.000000`;
    channel.messages.push({ user: "jordan (you)", text, ts, ...(threadTs ? { threadTs } : {}) });
    this.postedMessages.push({ channel: channel.id, text, ts, ...(threadTs ? { threadTs } : {}) });
    return ts;
  }
}

/** Memories seeded into a fresh demo agent, consistent with the world above. */
export const DEMO_SEED_MEMORIES: Array<{ text: string; tags: string[] }> = [
  { text: "Initech is our largest account; Ana Flores is the main contact and prefers email.", tags: ["initech", "ana"] },
  { text: "Initech's renewal conversation starts early September; they want a volume-pricing one-pager first.", tags: ["initech", "renewal", "deadline"] },
  { text: "Marcus Webb is the account executive for Initech — loop him in on anything commercial (#initech-account).", tags: ["marcus", "initech"] },
  { text: "Billing disputes over $500 are escalated to Sam in Billing; never promise refunds directly.", tags: ["process", "billing"] },
  { text: "The weekly support summary goes out Mondays before noon.", tags: ["process", "recurring"] },
  { text: "Never commit to engineering timelines in writing; say you'll check with the team and come back.", tags: ["process", "convention"] },
];
