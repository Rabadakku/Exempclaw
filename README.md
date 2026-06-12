# Exempclaw

A terminal-based framework for building and running many **Claude-powered
agents** that take over a departed employee's role — building context from
their past and current work, then operating through their channels (email,
Slack, Notion, GitHub) under a new persona.

Exempclaw uses **only the Claude API** for agent reasoning, by design.

> **Status: working.** The agent runtime, all four connectors, the onboarding
> ingestion pass, fleet orchestration (live events + schedules), approval
> gating, the audit trail, and the local dashboard are implemented and tested
> (100+ unit tests, no credentials required to run them).

```
CLI ─┬─ Orchestrator ── Agent (tool-use loop) ── { Claude · Tools · Memory · Connectors }
     └─ Dashboard (read-only ledger of runs, approvals, costs, memory)
```

---

## Quick start

```bash
# 1. Install (Node >= 22)
npm install

# 2. Preview the terminal experience (no key needed)
npm run dev -- demo

# 3. Configure
cp .env.example .env       # set ANTHROPIC_API_KEY; connector creds are optional
npm run dev -- doctor      # checks Node/key and live-probes any configured connectors

# 4. Seed an agent with its predecessor's context (optional but the point)
npm run dev -- ingest examples/agents/jordan-support-lead.json examples/archive

# 5. Talk to it
npm run dev -- chat examples/agents/jordan-support-lead.json

# one-shot, with a dry-run policy:
npm run dev -- run examples/agents/jordan-support-lead.json "What would you prioritize this week?" --policy deny
```

When connector credentials are in place (`exempclaw connectors` to check,
[docs/CONNECTORS.md](docs/CONNECTORS.md) to provision them):

```bash
# run the fleet: listen for inbound email/Slack/GitHub events, fire schedules
npm run dev -- start examples/agents/*.json

# watch it work: the Succession Ledger at http://127.0.0.1:4177
npm run dev -- dashboard examples/agents/*.json
```

`npm run build` compiles to `dist/` (the `exempclaw` bin).

---

## The lifecycle of an agent

**1. Define** — one JSON file per agent (`exempclaw init agents/sam.json` scaffolds it):

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
  "effort": "high",
  "connectors": ["email", "slack"],
  "toolPolicies": { "slack_post_message": "ask", "email_send": "ask" },
  "schedules": [{ "dailyAt": "09:00", "input": "Morning triage: …" }]
}
```

**2. Ingest** — `exempclaw ingest <agent.json> <dir>` reads the departed
employee's exported artifacts (mail, docs, notes — any text), distills them
into durable role memories with Claude (people, commitments, conventions,
in-flight work; never secrets), and synthesizes a role briefing. The agent
starts its first day already knowing the territory.

**3. Run** — `chat` for interactive work (streams live, shows tool activity),
`run` for one-shots, `start` for the always-on fleet: inbound events (a new
email, a Slack mention, a GitHub issue) are deduplicated, routed to the owning
agent, and handled in its persistent context. Schedules (`every` / `dailyAt`)
cover recurring duties like a morning triage pass.

**4. Observe** — every run lands in an append-only audit log: trigger, turns,
tokens, estimated cost, every outward action and whether a human approved it.
`exempclaw costs` aggregates spend; `exempclaw memory` / `history` inspect
state; `exempclaw dashboard` serves the read-only **Succession Ledger** UI on
localhost.

---

## The terminal experience

The CLI is fully animated (and degrades to plain lines when piped, in CI, or
with `EXEMPCLAW_NO_ANIM=1`):

- a **thinking spinner** with elapsed time while the model reasons, and live
  streamed text the moment it starts talking;
- one **animated row per tool call** — ✉ for email, # for Slack, ⎇ for
  GitHub, ▤ for Notion — settling into ✓/✗ with the call's duration;
- **agent-played animations**: every agent has a `display_status` tool it
  uses to narrate phases of work — a sweeping lens while *searching*, turning
  pages while *reading*, a cursor laying ink while *writing*, an envelope
  with a dot trail while *sending*, a sparkle burst when it *celebrates* a
  finished task, and a red blink for *alerts* it wants a human to see;
- animated **ingest progress** (▰▰▰▱▱ per chunk), **live doctor probes**, and
  one-shot **event flashes** in fleet mode;
- in chat: `/memory`, `/cost`, `/clear`, `/help`, and **Ctrl-C interrupts the
  current run** (history is saved) instead of killing the session.

`exempclaw demo` plays a scripted replay of all of it — no API key, no
credentials, nothing leaves the terminal.

---

## Outward-action safety

Anything that affects the outside world (sending email, posting to Slack,
writing to Notion/GitHub) is marked `outward` and routes through an approval
policy before it executes:

- `ask` (default) — prompt in the terminal: approve once, deny, or
  auto-approve that tool for the session
- `auto` — execute without prompting (once you trust an agent)
- `deny` — block all outward actions (dry-run / shadow mode)

Set the default with `EXEMPCLAW_ACTION_POLICY`, override per invocation with
`--policy`, and per tool in the agent config (`"toolPolicies": {
"slack_post_message": "auto", "*": "ask" }`). Every decision is recorded in
the run log.

---

## Memory & context

- **Durable memory** — atomic facts with source + tags, persisted per agent
  (`remember`/`recall` tools, the ingest pass, or `exempclaw memory --add`).
  The most recent slice is injected into the system prompt each run.
- **Conversation history** — survives restarts. When the prompt outgrows
  `EXEMPCLAW_CONTEXT_BUDGET_TOKENS` (default 200k), older turns are summarized
  by Claude and replaced with a compact digest; recent turns stay verbatim and
  tool-call pairs are never split.
- **Prompt caching** — the persona/tools prefix and the running conversation
  carry cache breakpoints, so long-lived agents mostly pay cache-read prices.

---

## Commands

| Command | What it does |
|---|---|
| `init <path>` | Scaffold an agent config (interactive or via flags) |
| `chat <agent>` | Animated REPL — streamed text, live tool rows, slash commands, Ctrl-C interrupts the run |
| `run <agent> <input>` | One-shot run; `--json` for the full result, `--policy` to override |
| `start <agents…>` | Fleet mode: connector listeners + schedules until Ctrl-C |
| `ingest <agent> <dir>` | Distill an export directory (incl. `.eml`/`.mbox`) into role memory + briefing |
| `dashboard [agents…]` | Read-only web ledger on 127.0.0.1 (`--port`, default 4177) |
| `demo` | Scripted replay of the animated TUI — no API key needed |
| `memory <agent>` | List/search durable memory; `--add`, `--rm` |
| `history <agent>` | Show the transcript; `--clear` to reset (memories kept) |
| `costs` | Tokens + estimated spend per agent from the audit log |
| `connectors` | Connector credential status |
| `doctor` | Environment check + live connector probes (`--no-probe` to skip) |

---

## Extending

Adding an integration = implementing the
[`Connector`](src/connectors/connector.ts) interface (tools + optional inbound
events) and registering it in [`src/connectors/index.ts`](src/connectors/index.ts).
The runtime and orchestrator don't change. See
[docs/CONNECTORS.md](docs/CONNECTORS.md#writing-your-own-connector) for
conventions, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full
design.

```bash
npm test            # 100+ unit tests, no network or credentials needed
npm run typecheck
```

---

## Responsible use

Operating an agent through a real person's role and accounts implicates
consent, impersonation, and bot-disclosure rules that vary by jurisdiction.
The framework makes the choices explicit — `disclosure` is a required persona
field (`transparent` / `on_request` / `opaque`), and even `opaque` agents are
instructed never to claim to be a specific named human and never to deny being
an AI when sincerely asked. Approval gating and the audit log exist so a human
stays accountable for outward actions. Having authorization for each connected
account, and meeting applicable notice/disclosure requirements, is on the
operator.
