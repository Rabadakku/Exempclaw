import type { Connector } from "./connector.js";
import { EmailConnector } from "./email/email-connector.js";
import { SlackConnector } from "./slack/slack-connector.js";
import { NotionConnector } from "./notion/notion-connector.js";
import { GitHubConnector } from "./github/github-connector.js";

export type { Connector, ConnectorContext, InboundEvent } from "./connector.js";
export { renderEventInput } from "./connector.js";

export interface ConnectorEnvKey {
  /** Config field name handed to the connector. */
  field: string;
  /** Environment variable it is read from. */
  env: string;
  required: boolean;
  note?: string;
}

interface RegistryEntry {
  make: () => Connector;
  envKeys: ConnectorEnvKey[];
  description: string;
}

/** Maps a connector id to its constructor and the env vars it consumes. */
const REGISTRY: Record<string, RegistryEntry> = {
  email: {
    make: () => new EmailConnector(),
    description: "IMAP inbox (read + live events) and SMTP send.",
    envKeys: [
      { field: "user", env: "EMAIL_USER", required: true },
      { field: "password", env: "EMAIL_PASSWORD", required: true, note: "app password for Gmail/Workspace" },
      { field: "imapHost", env: "EMAIL_IMAP_HOST", required: false, note: "needed for reading + events" },
      { field: "imapPort", env: "EMAIL_IMAP_PORT", required: false },
      { field: "smtpHost", env: "EMAIL_SMTP_HOST", required: false, note: "needed for sending" },
      { field: "smtpPort", env: "EMAIL_SMTP_PORT", required: false },
      { field: "from", env: "EMAIL_FROM", required: false, note: "defaults to EMAIL_USER" },
    ],
  },
  slack: {
    make: () => new SlackConnector(),
    description: "Slack Web API tools + Socket Mode mentions/DMs.",
    envKeys: [
      { field: "botToken", env: "SLACK_BOT_TOKEN", required: true, note: "xoxb-… bot token" },
      { field: "appToken", env: "SLACK_APP_TOKEN", required: false, note: "xapp-… enables inbound events" },
    ],
  },
  notion: {
    make: () => new NotionConnector(),
    description: "Notion search/read/write (share pages with the integration).",
    envKeys: [{ field: "token", env: "NOTION_TOKEN", required: true, note: "internal integration secret" }],
  },
  github: {
    make: () => new GitHubConnector(),
    description: "GitHub issues/PRs; polls GITHUB_REPOS for inbound events.",
    envKeys: [
      { field: "token", env: "GITHUB_TOKEN", required: true, note: "fine-grained PAT, Issues read/write" },
      { field: "repos", env: "GITHUB_REPOS", required: false, note: "comma-separated owner/name list" },
      { field: "pollSeconds", env: "GITHUB_POLL_SECONDS", required: false, note: "default 60" },
    ],
  },
};

export function availableConnectorIds(): string[] {
  return Object.keys(REGISTRY);
}

export interface ConnectorStatus {
  id: string;
  description: string;
  envKeys: Array<ConnectorEnvKey & { set: boolean }>;
  configured: boolean;
}

/** Reports each connector's env-var status for `exempclaw connectors`/`doctor`. */
export function connectorStatuses(env: NodeJS.ProcessEnv = process.env): ConnectorStatus[] {
  return Object.entries(REGISTRY).map(([id, entry]) => {
    const envKeys = entry.envKeys.map((key) => ({ ...key, set: Boolean(env[key.env]) }));
    return {
      id,
      description: entry.description,
      envKeys,
      configured: envKeys.filter((k) => k.required).every((k) => k.set),
    };
  });
}

/** Instantiates a connector by id and resolves its config from the environment. */
export function createConnector(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): { connector: Connector; config: Record<string, string> } {
  const entry = REGISTRY[id];
  if (!entry) {
    throw new Error(`unknown connector "${id}". Available: ${availableConnectorIds().join(", ")}`);
  }
  const config: Record<string, string> = {};
  for (const key of entry.envKeys) {
    const value = env[key.env];
    if (value) config[key.field] = value;
  }
  return { connector: entry.make(), config };
}
