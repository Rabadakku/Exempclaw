import type { Connector } from "./connector.js";
import { EmailConnector } from "./email/email-connector.js";
import { SlackConnector } from "./slack/slack-connector.js";
import { NotionConnector } from "./notion/notion-connector.js";
import { GitHubConnector } from "./github/github-connector.js";

export type { Connector, ConnectorContext, InboundEvent } from "./connector.js";

/** Maps a connector id to its constructor and the env vars it consumes. */
const REGISTRY: Record<string, { make: () => Connector; envKeys: Record<string, string> }> = {
  email: {
    make: () => new EmailConnector(),
    envKeys: {
      imapHost: "EMAIL_IMAP_HOST",
      imapPort: "EMAIL_IMAP_PORT",
      smtpHost: "EMAIL_SMTP_HOST",
      smtpPort: "EMAIL_SMTP_PORT",
      user: "EMAIL_USER",
      password: "EMAIL_PASSWORD",
    },
  },
  slack: {
    make: () => new SlackConnector(),
    envKeys: { botToken: "SLACK_BOT_TOKEN", appToken: "SLACK_APP_TOKEN" },
  },
  notion: {
    make: () => new NotionConnector(),
    envKeys: { token: "NOTION_TOKEN" },
  },
  github: {
    make: () => new GitHubConnector(),
    envKeys: { token: "GITHUB_TOKEN" },
  },
};

export function availableConnectorIds(): string[] {
  return Object.keys(REGISTRY);
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
  for (const [field, envKey] of Object.entries(entry.envKeys)) {
    const value = env[envKey];
    if (value) config[field] = value;
  }
  return { connector: entry.make(), config };
}
