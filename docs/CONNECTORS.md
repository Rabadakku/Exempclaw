# Connector setup

Each connector reads its credentials from the environment (see `.env.example`).
`exempclaw connectors` shows what's configured; `exempclaw doctor` checks the
whole environment. A connector contributes **tools** (what the agent can do)
and, where the platform allows it, **inbound events** (what wakes the agent up
under `exempclaw start`).

Anything marked *outward* routes through the approval policy before executing.

---

## Email (IMAP + SMTP)

| | |
|---|---|
| Tools | `email_list_inbox`, `email_read_message`, `email_search`, `email_mark_read`, `email_send` *(outward)* |
| Events | `email.received` — new INBOX mail via IMAP IDLE (auto-reconnects with backoff when the server drops the session) |

Setup:

1. Use a mailbox you are authorized to operate (typically the role account or
   the departed employee's company mailbox, per your IT policy).
2. For Gmail / Google Workspace: enable 2-step verification, then create an
   **app password** and use it as `EMAIL_PASSWORD` with
   `EMAIL_IMAP_HOST=imap.gmail.com` and `EMAIL_SMTP_HOST=smtp.gmail.com`.
3. Standard ports: IMAP 993 (TLS), SMTP 587 (STARTTLS) or 465 (TLS).
4. `EMAIL_FROM` sets the visible From header (defaults to `EMAIL_USER`).

You can configure IMAP only (read/triage), SMTP only (send), or both.
Replies thread correctly when the agent passes the original `messageId` as
`inReplyTo` — the read tools surface it for exactly that reason.

## Slack

| | |
|---|---|
| Tools | `slack_list_channels`, `slack_read_channel`, `slack_read_thread`, `slack_post_message` *(outward)* |
| Events | `slack.mention`, `slack.dm` — via Socket Mode (no public URL needed) |

Setup (Slack app, https://api.slack.com/apps):

1. Create an app in your workspace.
2. **OAuth & Permissions** → bot token scopes: `chat:write`,
   `channels:read`, `channels:history`, `groups:history`, `im:history`,
   `users:read`. Install to workspace → copy the **bot token** (`xoxb-…`)
   into `SLACK_BOT_TOKEN`.
3. For inbound events: **Socket Mode** → enable, create an **app-level
   token** (`xapp-…`) with `connections:write` → `SLACK_APP_TOKEN`. Then
   **Event Subscriptions** → enable and subscribe to the bot events
   `app_mention` and `message.im`.
4. Invite the bot to the channels it should read (`/invite @YourBot`).

Without `SLACK_APP_TOKEN` the tools still work; only inbound events are off.

## Notion

| | |
|---|---|
| Tools | `notion_search`, `notion_get_page`, `notion_append_block` *(outward)*, `notion_create_page` *(outward)* |
| Events | none (Notion has no push channel for internal integrations) |

Setup:

1. https://www.notion.so/my-integrations → new **internal** integration →
   copy the secret into `NOTION_TOKEN`.
2. **Share each relevant page/database with the integration** (page → ⋯ →
   Connections). Unshared content is invisible to the API — empty search
   results almost always mean this step was skipped.

Tools accept page ids or full Notion URLs.

## GitHub

| | |
|---|---|
| Tools | `github_list_issues`, `github_read_issue`, `github_comment` *(outward)*, `github_update_issue` *(outward — close/reopen/label)*, `github_create_issue` *(outward)* |
| Events | `github.issue_opened`, `github.issue_updated` — by polling `GITHUB_REPOS` |

Setup:

1. Create a **fine-grained personal access token** scoped to the target
   repositories with **Issues: read & write** (metadata read comes along) →
   `GITHUB_TOKEN`.
2. `GITHUB_REPOS=owner/repo,owner/other` enables inbound polling (default
   every 60s, tune with `GITHUB_POLL_SECONDS`). The first listed repo is also
   the default for tools when the model omits `repo`.

The connector suppresses events caused by the agent's own comments so it
doesn't reply to itself in a loop, and polling starts from "now" on each boot
(no backlog replay). Duplicates across restarts are dropped by the
orchestrator's persisted dedup.

---

## Writing your own connector

Implement the [`Connector`](../src/connectors/connector.ts) interface:

```ts
export class CrmConnector implements Connector {
  readonly id = "crm";
  async init(ctx) { /* validate ctx.config, build clients */ }
  tools() { return [/* defineTool(...) — mark outward actions */] }
  async listen(onEvent, signal) { /* optional: poll or subscribe until aborted */ }
  async shutdown() { /* release resources */ }
}
```

Then register it in [`src/connectors/index.ts`](../src/connectors/index.ts)
with the env vars it consumes. Conventions the built-ins follow:

- **Fail fast in `init`** when required credentials are missing.
- **Inject the transport** (a `fetchImpl`, client factories) through the
  constructor so the connector is unit-testable offline.
- Give every inbound event a stable `eventId` (the upstream id) — that's the
  dedup key — and a `threadId` the agent can reply to.
- Put reply instructions in the event `summary` (which tool + which ids), so
  the agent doesn't have to guess.
- Mark anything that writes to the outside world `outward: true`.

Nothing in the runtime or orchestrator changes when you add a connector.
