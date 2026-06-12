# Exempclaw — Architecture

Exempclaw is a terminal-based framework for building and running many
Claude-powered agents, each designed to take over a departed employee's role:
build context from that person's past and current work, then operate through
their channels (email, Slack, Notion, GitHub) under a new persona.

This document describes every component as implemented, and where each is
meant to grow.

---

## 1. Design goals

1. **Claude-only.** Every agent reasons through the Claude API
   (`@anthropic-ai/sdk`). There is deliberately no multi-provider abstraction —
   the `ClaudeClient` wrapper is the single integration point.
2. **A clean plugin boundary.** New integrations are added by implementing one
   interface (`Connector`); the agent runtime and orchestrator never change.
3. **Durable, per-agent memory.** Agents survive process restarts. Conversation
   history, accumulated knowledge, run records, and dedup state persist to disk
   (pluggable backend).
4. **Safe by construction.** Any action that touches the outside world routes
   through an approval policy (`ask` / `auto` / `deny`), overridable per tool,
   and every decision is written to an audit log.
5. **Many agents at once.** The orchestrator runs and supervises a fleet:
   inbound events route to the right agent, schedules fire, and a single agent
   never overlaps itself.
6. **Explicit identity & disclosure.** Whether an agent identifies itself as an
   AI is a required, first-class config choice — not an accident of prompting.

---

## 2. Layered architecture

```
┌────────────────────────────────────────────────────────────────┐
│ CLI (src/index.ts, src/cli)                                     │
│   init · chat · run · start · ingest · dashboard                │
│   memory · history · costs · connectors · doctor                │
├──────────────────────────────┬─────────────────────────────────┤
│ Orchestrator (src/orchestrator)                                 │
│   fleet build-out · per-agent run queues · event routing        │
│   persisted dedup (SeenEvents) · schedules (Scheduler)          │
├──────────────────────────────┴─────────────────────────────────┤
│ Agent runtime (src/agent)                                       │
│   tool-use loop · persona/system blocks · approval gating       │
│   parallel read-only tools · pause_turn · compaction trigger    │
│   run records · live hooks (streaming text, tool activity)      │
├───────────────┬───────────────┬──────────────┬─────────────────┤
│ LLM (src/llm) │ Tools         │ Memory        │ Connectors      │
│ ClaudeClient  │ registry +    │ MemoryStore   │ Connector iface │
│ adaptive      │ builtins +    │ file store +  │ email (IMAP/    │
│ thinking,     │ per-tool      │ compaction    │ SMTP) · slack   │
│ caching,      │ policies      │               │ (Web API +      │
│ streaming,    │               │               │ Socket Mode) ·  │
│ extract(),    │               │               │ notion · github │
│ refusals      │               │               │ (REST + poll)   │
├───────────────┴───────────────┴──────────────┴─────────────────┤
│ Ingest (src/ingest) — onboarding distillation pass              │
│ Dashboard (src/dashboard) — read-only ledger UI on 127.0.0.1    │
│ Core (src/core): errors · logger · usage/cost · run log         │
└────────────────────────────────────────────────────────────────┘
```

---

## 3. Component-by-component

### 3.1 Core (`src/core`)

- **`errors.ts`** — typed hierarchy rooted at `ExempclawError`, carrying a
  `retryable` flag. `ConnectorError`, `ToolExecutionError`, `ActionDeniedError`,
  `ConfigError`.
- **`logger.ts`** — dependency-free structured logger with child-binding
  support (`log.child({ agentId })`).
- **`usage.ts`** — token accounting (input/output/cache-read/cache-write) and
  cost estimation from per-model prices; cache reads bill ~0.1× input, writes
  1.25×.
- **`run-log.ts`** — append-only JSONL audit trail per agent: trigger, timing,
  usage, cost, stop reason, and **every outward action with its approval
  decision**. Substrate for `costs` and the dashboard.

### 3.2 Config (`src/config`)

Single place env vars are read and validated (Zod). `loadConfig()` requires
the API key; `loadOfflineConfig()` doesn't, so local commands (`memory`,
`history`, `costs`, `doctor`, `dashboard`) work without one. Global
`actionPolicy` and `contextBudgetTokens` live here.

### 3.3 LLM (`src/llm/claude.ts`)

`ClaudeClient` is the only place the SDK is touched:

- **`turn()`** — one assistant turn: adaptive thinking
  (`thinking: { type: "adaptive" }`), `output_config.effort` (default `high`),
  streaming with `finalMessage()` so large outputs don't hit HTTP timeouts,
  optional `onText` delta hook for live terminal output, abort-signal
  plumbing, and refusal handling (`stop_reason === "refusal"` →
  `RefusalError` so callers never read declined content).
- **Prompt caching** — callers pass system blocks with a breakpoint on the
  stable persona block; `turn()` adds a second breakpoint on the last message
  (`cacheConversation`), so tools + persona + the running conversation are
  served from cache on every iteration.
- **`extract()`** — one-shot structured output (`output_config.format` with a
  JSON schema derived from Zod), validated on the way out; the ingestion
  pipeline is built on it.
- **`summarize()`** — cheap low-effort call used by history compaction.
- The agent runtime depends on the **`ClaudeLike`** interface, so tests script
  turns without the network.

### 3.4 Tools (`src/tools`)

- **`Tool`** — `{ name, description, schema (Zod), outward, execute }`. The Zod
  schema is both runtime validation and the JSON Schema sent to Claude.
- **`outward`** marks a tool as acting on the world. Outward tools route
  through the approval policy before executing.
- **`resolvePolicy`** — effective policy per tool: exact `toolPolicies`
  override → `"*"` override → deployment default.
- **`builtin.ts`** — `remember`, `recall`, `current_time`, and
  `display_status` (the agent's animation channel to the operator's terminal)
  for every agent.

### 3.5 Memory (`src/memory`)

- **`MemoryStore`** interface: durable knowledge (add/search/remove) and
  conversation history (load/save/clear).
- **`FileMemoryStore`** — JSON files under `<dataDir>/agents/<id>/`, written
  atomically (temp file + rename) behind a per-store queue so concurrent tool
  calls can't tear state. Term-frequency scoring with tag boost and recency
  tiebreak.
- **`compaction.ts`** — when the prompt outgrows the context budget, the older
  portion of history is rendered to a transcript, summarized by Claude, and
  replaced with a compact exchange. The cut boundary is chosen so
  `tool_use`/`tool_result` pairs are never split.
- The interface is the seam for SQLite or an embeddings-backed store later;
  the runtime is unaffected by the swap.

### 3.6 Agent runtime (`src/agent`)

- **`persona.ts`** — `Persona` schema (name, role, who it succeeds, tone,
  guidance, `disclosure`). `buildSystemBlocks` produces a **stable block**
  (persona + operating principles, carrying the cache breakpoint) and a
  **dynamic block** (accumulated role memory) so memory growth doesn't
  invalidate the cached prefix.
- **`config.ts`** — `AgentConfig`: persona, model, effort, connectors,
  `toolPolicies`, `schedules` (`every: "15m"` or `dailyAt: "09:00"`).
- **`agent.ts`** — `Agent.run()` is the tool-use loop:
  1. Load history, append the new input, compose system blocks.
  2. Call Claude (streamed; deltas to hooks).
  3. `pause_turn` → re-send; `tool_use` → validate inputs, gate outward calls
     through the per-tool policy, execute (read-only calls in parallel,
     anything outward serialized), feed results back.
  4. Repeat until the model settles or `maxIterations`.
  5. Compact history if the prompt outgrew the budget, persist it, and append
     the run record (usage, cost, outward actions) — also on failure.

  Tool failures and denials come back as `is_error` tool results so the model
  adapts rather than crashes.

### 3.7 Connectors (`src/connectors`)

The primary extension point. A `Connector` contributes **tools** and optional
**inbound events** (with stable `eventId`s for dedup and `threadId`s for
replies). All four built-ins are real:

- **email** — IMAP (imapflow) for list/read/search and IDLE-driven
  `email.received` events; SMTP (nodemailer) for threaded sends. Self-sent
  mail is suppressed.
- **slack** — Web API over fetch for tools; **Socket Mode** over Node's
  built-in WebSocket for `slack.mention` / `slack.dm` events (no public URL
  required). Channel-name resolution and user-name caching included.
- **notion** — REST: search, page read (blocks → plain text), markdown
  append/create. No push channel exists for internal integrations.
- **github** — REST: issue triage and commenting; inbound events by polling
  `GITHUB_REPOS` with self-action suppression so the agent never replies to
  its own comment.

Shared plumbing: `http.ts` (timeouts, 429/5xx retry with Retry-After,
`ConnectorError` mapping, injectable `fetchImpl`). Every connector is
unit-tested offline through injected transports.

### 3.8 Ingest (`src/ingest`)

The onboarding pass (`exempclaw ingest`): walk an export directory (text-ish
files only, size-capped), pack files into ~24k-char chunks, distill each chunk
through `extract()` into atomic role memories (people, commitments, processes,
in-flight work — explicitly never secrets), then synthesize a role briefing.
`.eml` files are parsed into clean header+body text and `.mbox` archives are
split into individual parsed messages (via mailparser) before distillation.
Chunk count is capped to bound cost; usage is reported and progress streams as
structured events for the animated CLI.

### 3.9 Orchestrator (`src/orchestrator`)

- **`dispatch(agentId, input, opts)`** — runs one input, serialized behind a
  per-agent queue (a failed run can't poison it). Returns the full `RunResult`.
- **`start()`** — starts every connector listener and schedule, then blocks
  until shutdown. Inbound events pass through **`SeenEvents`** — a persisted,
  bounded dedup of `connector:eventId` keys — before dispatch, so Slack
  envelope retries, poll overlap, and restarts don't double-run the agent.
- **`Scheduler`** — interval (`every`) and daily wall-clock (`dailyAt`)
  triggers with an injectable clock for tests.
- **`shutdown()`** — aborts in-flight work, stops schedules, releases
  connectors, persists dedup state.

### 3.10 Dashboard (`src/dashboard`)

`exempclaw dashboard` serves a **read-only** single-page console (the
"Succession Ledger") on 127.0.0.1: the fleet roster as personnel dossiers,
per-agent run ledger with outward-action stamps (approved/denied), token and
spend aggregates, and the most recent role memory. Zero frontend dependencies —
one HTML document over `node:http`, polling `/api/fleet`. It reads the same
files the runtime writes (`runs.jsonl`, `memory.json`); nothing is mutable
from the browser.

### 3.11 CLI & TUI (`src/index.ts`, `src/cli`)

Commander-based, with a dependency-free animation engine (`cli/tui.ts`):

- **Stage** — a live region of animated rows redrawn in place while ordinary
  output scrolls above it; rows settle into permanent ✓/✗ lines with their
  duration. Suspends around interactive prompts (approvals, `/clear`), hides
  and restores the cursor, and degrades to plain printed lines when stdout
  isn't a TTY or `EXEMPCLAW_NO_ANIM` is set — so tests and pipes stay clean.
- **Live hooks** (`cli/live.ts`) bridge agent `RunHooks` to the stage: a
  thinking spinner per model turn, streamed text, one row per in-flight tool
  call (parallel calls animate side by side), and the agent's own status
  signals.
- **Agent-played animations** — every agent has a built-in `display_status`
  tool. Calling it emits through `ToolContext.emit` → `RunHooks.onStatus` →
  an expressive animation in the operator's terminal (searching / reading /
  writing / sending / waiting / celebrating / alert). In fleet mode with no
  TUI attached it falls back to a log line.
- `chat` adds slash commands (`/memory`, `/cost`, `/clear`, `/help`) and
  graceful interruption: Ctrl-C aborts the in-flight run (history and the run
  record are still written, `stopReason: "interrupted"`) without leaving the
  REPL.
- `doctor` runs **live probes** against every configured connector in
  parallel animated rows (IMAP login, SMTP verify, Slack `auth.test` +
  Socket-Mode open, Notion `/users/me`, GitHub `/user` + per-repo reach).
- `demo` replays a scripted session through the real pipeline so the TUI can
  be previewed (and terminal-compatibility-tested) with no API key.
- Offline commands (`memory`, `history`, `costs`, `connectors`, `doctor`,
  `dashboard`, `demo`) run without an API key.

---

## 4. Identity, disclosure & authorization

Taking over a real person's role and channels raises consent, impersonation,
and bot-disclosure questions. The framework makes the relevant choices explicit
rather than implicit:

- **`disclosure`** per persona: `transparent` (always identifies as AI),
  `on_request` (identifies when asked or when legally required), or `opaque`
  (operates under its persona without volunteering). The system prompt encodes
  the chosen mode; even `opaque` forbids claiming to be a specific named human,
  forbids denying being an AI when sincerely asked, and requires
  legally-mandated disclosure.
- **Approval policy** per deployment and per tool: outward actions can require
  human sign-off, and the prompt instructs agents never to claim an action
  happened without a confirming tool result.
- **Audit trail:** every run persists its transcript and a run record; every
  outward action is logged with its approval decision; the dashboard makes the
  whole ledger visible.

Operators are responsible for using the framework lawfully (notice/consent for
processing a departed employee's data, jurisdiction-specific bot-disclosure
rules, and access authorization for each connected account).

---

## 5. Roadmap (near → far)

1. **Approval surfaces beyond the terminal** — approve/deny from Slack or the
   dashboard (turning it read-write behind auth), with per-recipient policies.
2. **Vector memory** — embeddings-backed `MemoryStore` for semantic recall
   over large ingested archives; the interface is already in place.
3. **Connector-driven ingestion** — pull history directly from Slack/GitHub/
   Notion/IMAP instead of (or in addition to) file exports.
4. **Multi-agent collaboration** — agents delegating to each other (a
   coordinator pattern), mapping naturally onto Claude's tool-use surfaces.
5. **Persistence hardening** — SQLite/Postgres state, crash-consistent run
   records, replay tooling.
6. **Observability extensions** — per-thread drill-downs, transcript replay in
   the dashboard, exportable reports.
