# Exempclaw — Architecture & Design Plan

Exempclaw is a terminal-based framework for building and running many
Claude-powered agents, each designed to take over a departed employee's role:
build context from that person's past and current work, then operate through
their channels (email, Slack, Notion, GitHub, …) under a new persona.

This document is the detailed plan for every component. It describes what exists
in the foundation today and how each piece is meant to grow.

---

## 1. Design goals

1. **Claude-only.** Every agent reasons through the Claude API
   (`@anthropic-ai/sdk`). There is deliberately no multi-provider abstraction —
   the `ClaudeClient` wrapper is the single integration point.
2. **A clean plugin boundary.** New integrations are added by implementing one
   interface (`Connector`); the agent runtime and orchestrator never change.
3. **Durable, per-agent memory.** Agents survive process restarts. Conversation
   history and accumulated knowledge persist to disk (pluggable backend).
4. **Safe by construction.** Any action that touches the outside world routes
   through an approval policy (`ask` / `auto` / `deny`).
5. **Many agents at once.** The orchestrator runs and supervises a fleet,
   routing inbound events to the right agent.
6. **Explicit identity & disclosure.** Whether an agent identifies itself as an
   AI is a required, first-class config choice — not an accident of prompting.

---

## 2. Layered architecture

```
┌──────────────────────────────────────────────────────────────┐
│ CLI (src/index.ts, src/cli)                                   │
│   run · chat · start · connectors                             │
├──────────────────────────────────────────────────────────────┤
│ Orchestrator (src/orchestrator)                               │
│   fleet management · event routing · per-agent run queues      │
├──────────────────────────────────────────────────────────────┤
│ Agent runtime (src/agent)                                     │
│   tool-use loop · persona/system prompt · approval gating      │
├───────────────┬───────────────┬──────────────┬───────────────┤
│ LLM (src/llm) │ Tools         │ Memory        │ Connectors    │
│ ClaudeClient  │ registry +    │ MemoryStore   │ Connector     │
│ adaptive      │ builtin tools │ (file/SQLite/ │ interface +   │
│ thinking,     │ + approval    │ vector)       │ email/slack/  │
│ effort,       │ policy        │               │ notion/github │
│ refusal       │               │               │               │
├───────────────┴───────────────┴──────────────┴───────────────┤
│ Core (src/core): errors · logger · (events)                   │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Component-by-component

### 3.1 Core (`src/core`)

- **`errors.ts`** — typed hierarchy rooted at `ExempclawError`, carrying a
  `retryable` flag. `ConnectorError`, `ToolExecutionError`, `ActionDeniedError`,
  `ConfigError`. The runtime branches on these to distinguish recoverable
  failures (rate limits, connector outages) from programming errors.
- **`logger.ts`** — dependency-free structured logger with child-binding support
  (`log.child({ agentId })`). Swap for pino behind the same `Logger` interface.

### 3.2 Config (`src/config`)

Single place env vars are read and validated (Zod). Produces a typed
`RuntimeConfig`. Global `actionPolicy` lives here. Per-agent config is separate
(see 3.6).

### 3.3 LLM (`src/llm/claude.ts`)

`ClaudeClient.turn()` runs one assistant turn:

- Default model `claude-opus-4-8` (override per agent).
- **Adaptive thinking** (`thinking: { type: "adaptive" }`) — the recommended
  mode; depth is controlled by `effort` (`low`…`max`), not a token budget.
- **Streaming by default** with `.finalMessage()`, so large outputs don't hit
  HTTP timeouts.
- **Refusal handling** — throws `RefusalError` on `stop_reason === "refusal"` so
  the caller never reads `content` from a declined response.

The agent runtime depends on this class only; the SDK is not used elsewhere.

### 3.4 Tools (`src/tools`)

- **`Tool`** — `{ name, description, schema (Zod), outward, execute }`. The Zod
  schema is both runtime validation and the JSON Schema sent to Claude
  (`z.toJSONSchema`).
- **`outward`** marks a tool as acting on the world (send/post/write). Outward
  tools route through the approval policy before executing.
- **`ToolRegistry`** — per-agent set; renders to Anthropic tool definitions.
- **`evaluatePolicy`** — `auto` → allow, `deny` → block, `ask` → defer to an
  interactive approver (terminal today; swap for web/Slack).
- **`builtin.ts`** — `remember`, `recall`, `current_time`. Every agent gets
  these so it has memory + a clock without any connector.

### 3.5 Memory (`src/memory`)

- **`MemoryStore`** interface: durable knowledge (`addMemory`/`searchMemory`)
  and conversation history (`loadHistory`/`saveHistory`).
- **`FileMemoryStore`** — JSON files under `<dataDir>/agents/<id>/`. Naive
  keyword retrieval today.
- **Planned:** a `SqliteMemoryStore` and a vector-backed store for semantic
  recall over a departed employee's full history. The interface is designed so
  the runtime is unaffected by the swap.

### 3.6 Agent runtime (`src/agent`)

- **`persona.ts`** — `Persona` schema (name, role, who it succeeds, tone,
  guidance, `disclosure`). `buildSystemPrompt` composes the persona, succession
  framing, disclosure instructions, operating principles, and accumulated
  memory into the system prompt.
- **`config.ts`** — `AgentConfig` (id, persona, model, effort, connectors). One
  JSON file per agent (`examples/agents/*.json`).
- **`agent.ts`** — `Agent.run()` is the tool-use loop:
  1. Load history, append the new user input.
  2. Call Claude with the system prompt + tools.
  3. Append the assistant turn; if it requested tools, validate inputs, gate
     outward calls through the approval policy, execute, and feed results back.
  4. Repeat until the model stops calling tools or `maxIterations` is hit.
  5. Persist history.

  Tool failures and denials come back as `is_error` tool results so the model
  can adapt rather than crash.

### 3.7 Connectors (`src/connectors`)

The primary extension point. A `Connector` contributes **tools** (capabilities)
and **inbound events** (triggers). `email` is the worked example; `slack`,
`notion`, and `github` are structural stubs with real tool surfaces and TODO
plumbing. The registry (`index.ts`) maps a connector id to its constructor and
the env vars it consumes.

Adding an integration = implement `Connector` + register it. Nothing else moves.

### 3.8 Orchestrator (`src/orchestrator`)

Runs the fleet. For each agent it builds the Claude client, tool registry
(builtins + connector tools), and memory store; initializes connectors; and:

- **`dispatch(agentId, input)`** — runs one input, serialized behind a per-agent
  queue so an agent never overlaps itself.
- **`start()`** — starts every connector listening and routes each inbound event
  to the owning agent's run loop.
- **`shutdown()`** — aborts in-flight work and releases connector resources.

---

## 4. Identity, disclosure & authorization

Taking over a real person's role and channels raises consent, impersonation, and
bot-disclosure questions. The framework makes the relevant choices explicit
rather than implicit:

- **`disclosure`** per persona: `transparent` (always identifies as AI),
  `on_request` (identifies when asked or when legally required), or `opaque`
  (operates under its persona without volunteering). The system prompt encodes
  the chosen mode, and even `opaque` forbids false claims of being a specific
  named human and requires legally-mandated disclosure.
- **Approval policy** per deployment: outward actions can require human sign-off.
- **Audit trail:** every run persists its transcript; outward actions are logged.

Operators are responsible for using the framework lawfully (notice/consent for
processing a departed employee's data, jurisdiction-specific bot-disclosure
rules, and access authorization for each connected account).

---

## 5. Roadmap (near → far)

1. **Real connector plumbing** — IMAP/SMTP (email), `@slack/web-api`,
   `@notionhq/client`, `@octokit/rest` + webhooks.
2. **Onboarding/ingestion pass** — a one-time job that reads a departed
   employee's history across connectors and seeds the agent's memory with the
   role's people, threads, commitments, and conventions.
3. **Vector memory** — embeddings-backed `MemoryStore` for semantic recall;
   server-side compaction for very long histories.
4. **Better human-in-the-loop** — web/Slack approval surfaces beyond the
   terminal; per-tool and per-recipient policies.
5. **Multi-agent collaboration** — agents delegating to each other (a coordinator
   pattern), mapping naturally onto Claude's tool-use and managed-agent surfaces.
6. **Observability** — token/cost dashboards, run history browsing, replay.
7. **Persistence hardening** — SQLite/Postgres state, crash recovery,
   at-least-once event handling with dedup on `threadId`.
