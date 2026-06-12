# Exempclaw

A terminal-based framework for building and running many **Claude-powered agents**
that take over a departed employee's role — building context from their past and
current work, then operating through their channels (email, Slack, Notion,
GitHub, …) under a new persona.

Exempclaw uses **only the Claude API** for agent reasoning, by design.

> **Status:** foundation. The core runtime, tool/plugin system, memory,
> approval gating, and orchestrator are implemented and compile. Connectors are
> structural stubs (real tool surfaces, TODO network plumbing) so you can wire
> in IMAP/SMTP, Slack, Notion, and GitHub without touching the core.

---

## Why it's structured this way

The hard parts of replacing a knowledge worker aren't the Claude calls — they're
the **integration boundary**, **durable memory**, **safe outward actions**, and
**running many agents at once**. Exempclaw is organized around exactly those
seams. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.

```
CLI → Orchestrator → Agent (tool-use loop) → { Claude · Tools · Memory · Connectors }
```

---

## Quick start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
#   set ANTHROPIC_API_KEY (required). Connector creds are optional until you
#   wire up a connector.

# 3. Talk to the example agent
npm run dev -- chat examples/agents/jordan-support-lead.json

# one-shot:
npm run dev -- run examples/agents/jordan-support-lead.json "Summarize what you'd prioritize this week."

# list available connectors:
npm run dev -- connectors

# run a fleet that listens for inbound events:
npm run dev -- start examples/agents/jordan-support-lead.json
```

Build a standalone binary with `npm run build` (output in `dist/`).

---

## Defining an agent

One JSON file per agent (see [`examples/agents`](examples/agents)):

```json
{
  "id": "jordan-support-lead",
  "persona": {
    "name": "Jordan",
    "role": "Customer Support Lead",
    "succeeds": "Alex Rivera",
    "tone": "warm, concise, proactive",
    "disclosure": "transparent"
  },
  "model": "claude-opus-4-8",
  "connectors": ["email", "slack"]
}
```

`disclosure` controls how the agent presents itself: `transparent`,
`on_request`, or `opaque`. See the architecture doc's identity section.

---

## Outward-action safety

Anything that affects the outside world (sending email, posting to Slack,
writing to Notion/GitHub) is marked `outward` and routes through the approval
policy set by `EXEMPCLAW_ACTION_POLICY`:

- `ask` (default) — prompts you in the terminal before each outward action
- `auto` — executes without prompting (use once you trust an agent)
- `deny` — blocks all outward actions (dry-run / shadow mode)

---

## Adding a connector

Implement the [`Connector`](src/connectors/connector.ts) interface (contribute
`tools()` and optionally `listen()`), then register it in
[`src/connectors/index.ts`](src/connectors/index.ts). The agent runtime and
orchestrator require no changes. [`EmailConnector`](src/connectors/email/email-connector.ts)
is the worked example.

---

## Responsible use

Operating an agent under a real person's role and accounts implicates consent,
impersonation, and bot-disclosure considerations that vary by jurisdiction. You
are responsible for having authorization for each connected account and for
meeting applicable notice/disclosure requirements. The framework gives you the
controls (disclosure modes, approval gating, audit logs) — using them lawfully
is on the operator.
