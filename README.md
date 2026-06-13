# Exempclaw
ALPHA
**Run helpful AI agents from your terminal — no coding required to get started.**

Exempclaw lets you create a Claude-powered assistant that can cover a role:
read and reply to email, watch a Slack channel, keep notes, and follow a
daily routine — all under a persona you define, with you approving anything it
sends. It runs in a friendly menu you drive with the arrow keys. Powered
exclusively by the **Claude API**.

```
  (\/)  E X E M P C L A W      fleet command

   ❯ Agents        2 configured
     New agent     guided setup
     History       all runs, all agents
     Plugins       1 installed
     Doctor        check my setup
     Quit

   ↑↓ move · enter select · q quit
```

---

## 👋 New here? Start in 30 seconds

You need [Node.js 22 or newer](https://nodejs.org) (a free, one-click install).
Then open your terminal and run **one** of these:

```bash
# Just try it — nothing to install:
npx exempclaw

# …or install it for keeps:
npm install -g exempclaw          # then type:  exempclaw
brew install Rabadakku/tap/exempclaw   # (macOS, Homebrew)
```

That's it. Type **`exempclaw`** and you'll land in the menu above. From there:

1. **New agent** walks you through creating your first assistant — it asks
   plain questions (its name, what it does, how it should sound) and explains
   every choice. No files to edit.
2. **Doctor** checks your setup and tells you, in plain English, exactly what
   to fix.
3. **Agents** lists everyone you've created. Pick one to chat with it.

**No Claude API key yet?** Run `exempclaw demo` for a full guided tour that
costs nothing and sends nothing — it's all pretend data. When you're ready for
the real thing, get a key at
[console.anthropic.com](https://console.anthropic.com) and paste it where
Doctor tells you to.

> **Why a key?** Exempclaw runs on Claude, Anthropic's AI. The key is how your
> usage is billed to *your* Anthropic account — Exempclaw never uses anyone
> else's.

---

## What you can do with it

- **Create an assistant in minutes** through the guided wizard — give it a
  name, a job, and a tone of voice.
- **Chat with it** right in the terminal. It thinks out loud, shows you what
  it's doing, and streams its answer as it types.
- **Let it watch your channels** (email, Slack, Notion, GitHub) and handle
  what comes in — but it always asks before sending anything, unless you tell
  it otherwise.
- **Stay in control.** Every action it takes is logged. You can review the
  full history, see what it cost, and approve or deny anything that goes out.
- **Teach it the ropes.** Point it at a folder of past emails or docs and it
  distills them into lasting memory, so it starts already knowing the context.
- **Add new powers with plugins** — drop a folder in, restart, done.

---

<!-- ============================================================= -->

## 🛠️ For developers

Everything below is the technical reference. Jump to what you need:

- [How it works](#how-it-works)
- [Installing from source](#installing-from-source)
- [The agent lifecycle](#the-agent-lifecycle)
- [Agent config reference](#agent-config-reference)
- [Command reference](#command-reference)
- [Writing a plugin](#writing-a-plugin)
- [Connectors](#connectors)
- [Outward-action safety](#outward-action-safety)
- [Memory & context](#memory--context)
- [Project layout & tests](#project-layout--tests)
- [Responsible use](#responsible-use)

### How it works

A single process owns the fleet. The menu (an [ink](https://github.com/vadimdemedes/ink)
TUI) and every CLI subcommand drive the same orchestrator, which runs each
agent's tool-use loop against the Claude API.

```
exempclaw ─┬─ TUI menu ───────┐
           ├─ chat / run ──────┼─ Orchestrator ─ Agent (tool-use loop)
           ├─ start (fleet) ───┘        │            └ { Claude · Tools · Memory · Connectors }
           └─ dashboard (read-only ledger: runs, approvals, costs, memory)
```

Bare `exempclaw` opens the TUI when stdin/stdout are a real terminal; in a
pipe or CI it prints help instead. All the classic subcommands still exist for
scripting — the TUI is a friendlier front door, not a replacement.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

### Installing from source

```bash
git clone https://github.com/Rabadakku/Exempclaw.git
cd exempclaw
npm install
npm run dev            # runs the TUI from source (tsx)
npm run build          # compiles to dist/ (the `exempclaw` bin)
```

`npm run dev -- <subcommand>` runs any CLI command from source, e.g.
`npm run dev -- doctor`.

### The agent lifecycle

**1. Define** — one JSON file per agent. The **New agent** wizard writes these
for you; `exempclaw init agents/sam.json` is the scriptable equivalent. Files
live in your agents directory (`./agents` in a project, otherwise
`~/.exempclaw/agents`; override with `EXEMPCLAW_AGENTS_DIR`).

**2. Ingest** *(optional, but the point)* — `exempclaw ingest <agent.json>
<dir>` reads exported artifacts (mail, docs, notes — any text), distills them
into durable role memories with Claude (people, commitments, conventions,
in-flight work — never secrets), and synthesizes a role briefing. The agent
starts already knowing the territory.

**3. Run** — `chat` for interactive work, `run` for one-shots, `start` for the
always-on fleet: inbound events (a new email, a Slack mention, a GitHub issue)
are deduplicated, routed to the owning agent, and handled in its persistent
context. Schedules (`every` / `dailyAt`) cover recurring duties.

**4. Observe** — every run lands in an append-only audit log: trigger, turns,
tokens, estimated cost, every outward action and who approved it. The TUI's
**History** screen browses it; `exempclaw costs` aggregates spend; `exempclaw
dashboard` serves the read-only **Succession Ledger** on localhost.

### Agent config reference

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

`disclosure` is required and is one of `transparent` (always says it's an AI),
`on_request` (answers truthfully when asked), or `opaque` (doesn't volunteer
it — but still never denies being an AI when sincerely asked, and never claims
to be a specific named human). See [Responsible use](#responsible-use).

### Command reference

The TUI covers the common path; these are the full subcommands (also useful
for scripting and automation):

| Command | What it does |
|---|---|
| *(none)* | Open the full-screen fleet menu (same as `ui`) |
| `ui` | Open the full-screen fleet menu explicitly |
| `init <path>` | Scaffold an agent config (interactive or via flags) |
| `chat <agent>` | Animated REPL — streamed text, live tool rows, slash commands, Ctrl-C interrupts the run |
| `run <agent> <input>` | One-shot run; `--json` for the full result, `--policy` to override |
| `start <agents…>` | Fleet mode: connector listeners + schedules until Ctrl-C |
| `ingest <agent> <dir>` | Distill an export directory (incl. `.eml`/`.mbox`) into role memory + briefing |
| `plugin create <name>` | Scaffold a new plugin with a working example tool |
| `plugin list` | List discovered plugins and any load errors |
| `dashboard [agents…]` | Read-only web ledger on 127.0.0.1 (`--port`, default 4177) |
| `demo` | Scripted replay of the animated TUI — no API key needed |
| `memory <agent>` | List/search durable memory; `--add`, `--rm` |
| `history <agent>` | Show the transcript; `--clear` to reset (memories kept) |
| `costs` | Tokens + estimated spend per agent from the audit log |
| `connectors` | Connector credential status |
| `doctor` | Environment check + live connector probes (`--no-probe` to skip) |

### Writing a plugin

A plugin adds **tools** (capabilities an agent can call) and/or **connectors**
(full integrations) without touching the core. Plugins can't change the LLM —
Exempclaw is Claude-only by design.

```bash
exempclaw plugin create weather       # scaffolds ~/.exempclaw/plugins/weather
```

That generates a working, zero-install plugin you can edit immediately:

```js
// ~/.exempclaw/plugins/weather/index.js
export default function ({ z, defineTool, definePlugin }) {
  return definePlugin({
    name: "weather",
    tools: [
      defineTool({
        name: "weather_hello",
        description: "Example tool — replace with your own.",
        schema: z.object({ who: z.string() }),
        execute: async ({ who }) => ({ content: `Hello, ${who}!` }),
      }),
    ],
  });
}
```

Restart `exempclaw` and open **Plugins** — yours appears with its tools, or
with a load error to fix (a broken plugin never crashes the app). Plugins are
discovered in `~/.exempclaw/plugins` (override with `EXEMPCLAW_PLUGINS_DIR`).
Each scaffold ships a `PLUGIN.md` documenting the full interface, including how
to write connectors and how TypeScript authors can import types from
`exempclaw/plugin`.

### Connectors

Built-in connectors: **email** (IMAP/SMTP), **Slack** (Web API + Socket Mode),
**Notion**, **GitHub**. Each contributes tools and, optionally, inbound events.
Credentials come from the environment — `exempclaw connectors` shows status,
[docs/CONNECTORS.md](docs/CONNECTORS.md) explains provisioning. Adding one
means implementing the [`Connector`](src/connectors/connector.ts) interface;
the runtime and orchestrator don't change. For third-party integrations,
prefer a [plugin](#writing-a-plugin).

### Outward-action safety

Anything that affects the outside world (sending email, posting to Slack,
writing to Notion/GitHub) is marked `outward` and routes through an approval
policy before it executes:

- `ask` (default) — prompt to approve once, deny, or auto-approve that tool
  for the session. In the TUI this is an inline yes/no dialog.
- `auto` — execute without prompting (once you trust an agent)
- `deny` — block all outward actions (dry-run / shadow mode)

Set the default with `EXEMPCLAW_ACTION_POLICY`, override per invocation with
`--policy`, and per tool in the agent config. Every decision is recorded in the
run log.

### Memory & context

- **Durable memory** — atomic facts with source + tags, persisted per agent
  (`remember`/`recall` tools, the ingest pass, or `exempclaw memory --add`).
  The most recent slice is injected into the system prompt each run.
- **Conversation history** — survives restarts. When the prompt outgrows
  `EXEMPCLAW_CONTEXT_BUDGET_TOKENS` (default 200k), older turns are summarized
  by Claude and replaced with a compact digest; recent turns stay verbatim and
  tool-call pairs are never split.
- **Prompt caching** — the persona/tools prefix and the running conversation
  carry cache breakpoints, so long-lived agents mostly pay cache-read prices.

### Project layout & tests

```
src/ui/          ink TUI (menu, screens, components)
src/agent/       the agent tool-use loop, persona, config
src/orchestrator/ fleet supervision, routing, scheduling
src/connectors/  email · slack · notion · github
src/plugins/     plugin loader + public definePlugin API
src/tools/       built-in tools
src/memory/      durable memory + history compaction
src/core/        logger, run log, usage/cost
```

```bash
npm test            # 160+ unit tests, no network or credentials needed
npm run typecheck
```

### Responsible use

Operating an agent through a real person's role and accounts implicates
consent, impersonation, and bot-disclosure rules that vary by jurisdiction.
The framework makes the choices explicit — `disclosure` is a required persona
field, and even `opaque` agents are instructed never to claim to be a specific
named human and never to deny being an AI when sincerely asked. Approval gating
and the audit log exist so a human stays accountable for outward actions.
Having authorization for each connected account, and meeting applicable
notice/disclosure requirements, is on the operator.

---

## License

[MIT](LICENSE) © 2026 Joseph Santana
