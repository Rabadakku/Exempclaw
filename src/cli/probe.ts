import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { HttpJson, type FetchLike } from "../connectors/http.js";

/**
 * Live connectivity probes for `exempclaw doctor`. Each probe actually
 * authenticates against the upstream service (read-only) and reports what it
 * found. Transports are injectable for tests.
 */

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

const TIMEOUT_MS = 12_000;

export async function probeSlack(config: Record<string, string>, fetchImpl?: FetchLike): Promise<ProbeResult> {
  try {
    const api = new HttpJson({
      connector: "slack",
      baseUrl: "https://slack.com/api",
      headers: { authorization: `Bearer ${config.botToken}` },
      fetchImpl,
      timeoutMs: TIMEOUT_MS,
      maxRetries: 0,
    });
    const auth = await api.post<{ ok: boolean; error?: string; team?: string; user?: string }>("/auth.test", {});
    if (!auth.ok) return { ok: false, detail: auth.error ?? "auth.test failed" };
    let socket = "events off (no SLACK_APP_TOKEN)";
    if (config.appToken) {
      const appApi = new HttpJson({
        connector: "slack",
        baseUrl: "https://slack.com/api",
        headers: { authorization: `Bearer ${config.appToken}` },
        fetchImpl,
        timeoutMs: TIMEOUT_MS,
        maxRetries: 0,
      });
      const open = await appApi.post<{ ok: boolean; error?: string }>("/apps.connections.open", {});
      socket = open.ok ? "socket mode ready" : `socket mode failed: ${open.error ?? "?"}`;
      if (!open.ok) return { ok: false, detail: `bot ok (${auth.team}) but ${socket}` };
    }
    return { ok: true, detail: `${auth.user} @ ${auth.team} · ${socket}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export async function probeNotion(config: Record<string, string>, fetchImpl?: FetchLike): Promise<ProbeResult> {
  try {
    const api = new HttpJson({
      connector: "notion",
      baseUrl: "https://api.notion.com/v1",
      headers: { authorization: `Bearer ${config.token}`, "notion-version": "2022-06-28" },
      fetchImpl,
      timeoutMs: TIMEOUT_MS,
      maxRetries: 0,
    });
    const me = await api.get<{ name?: string; bot?: { workspace_name?: string } }>("/users/me");
    return { ok: true, detail: `integration "${me.name ?? "?"}"${me.bot?.workspace_name ? ` in ${me.bot.workspace_name}` : ""}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export async function probeGitHub(config: Record<string, string>, fetchImpl?: FetchLike): Promise<ProbeResult> {
  try {
    const api = new HttpJson({
      connector: "github",
      baseUrl: "https://api.github.com",
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "exempclaw",
      },
      fetchImpl,
      timeoutMs: TIMEOUT_MS,
      maxRetries: 0,
    });
    const me = await api.get<{ login: string }>("/user");
    const repos = (config.repos ?? "").split(",").map((r) => r.trim()).filter(Boolean);
    const failures: string[] = [];
    for (const repo of repos) {
      try {
        await api.get(`/repos/${repo}`);
      } catch {
        failures.push(repo);
      }
    }
    if (failures.length > 0) {
      return { ok: false, detail: `as ${me.login}, but cannot reach: ${failures.join(", ")}` };
    }
    return { ok: true, detail: `as ${me.login}${repos.length ? ` · ${repos.length} repo(s) reachable` : ""}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export interface EmailProbeTransports {
  imapFactory?: (opts: ConstructorParameters<typeof ImapFlow>[0]) => Pick<ImapFlow, "connect" | "logout">;
  smtpFactory?: typeof createTransport;
}

export async function probeEmail(
  config: Record<string, string>,
  transports: EmailProbeTransports = {},
): Promise<ProbeResult> {
  const parts: string[] = [];
  try {
    if (config.imapHost) {
      const imapFactory = transports.imapFactory ?? ((opts) => new ImapFlow(opts));
      const client = imapFactory({
        host: config.imapHost,
        port: Number(config.imapPort ?? 993),
        secure: Number(config.imapPort ?? 993) === 993,
        auth: { user: config.user!, pass: config.password! },
        logger: false,
        connectionTimeout: TIMEOUT_MS,
      });
      await client.connect();
      await client.logout().catch(() => undefined);
      parts.push(`imap ${config.imapHost} ok`);
    }
    if (config.smtpHost) {
      const smtpFactory = transports.smtpFactory ?? createTransport;
      const transport = smtpFactory({
        host: config.smtpHost,
        port: Number(config.smtpPort ?? 587),
        secure: Number(config.smtpPort ?? 587) === 465,
        auth: { user: config.user!, pass: config.password! },
        connectionTimeout: TIMEOUT_MS,
      });
      try {
        await transport.verify();
        parts.push(`smtp ${config.smtpHost} ok`);
      } finally {
        transport.close();
      }
    }
    if (parts.length === 0) return { ok: false, detail: "no IMAP or SMTP host configured" };
    return { ok: true, detail: parts.join(" · ") };
  } catch (err) {
    return { ok: false, detail: [...parts, (err as Error).message].join(" · ") };
  }
}

export type Prober = (config: Record<string, string>) => Promise<ProbeResult>;

/** Probe per connector id; consumed by `doctor`. */
export const PROBES: Record<string, Prober> = {
  slack: (config) => probeSlack(config),
  notion: (config) => probeNotion(config),
  github: (config) => probeGitHub(config),
  email: (config) => probeEmail(config),
};
