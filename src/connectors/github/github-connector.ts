import { z } from "zod";
import { sleep, type Connector, type ConnectorContext, type InboundEvent } from "../connector.js";
import { HttpJson, type FetchLike } from "../http.js";
import { ConnectorError } from "../../core/errors.js";
import { defineTool, type Tool } from "../../tools/tool.js";
import type { Logger } from "../../core/logger.js";

/**
 * GitHub connector over the REST API. Tools cover issue/PR triage and
 * commenting; inbound events come from polling the configured repos
 * (GITHUB_REPOS) for recently-updated issues — webhooks need a public
 * endpoint, polling doesn't.
 *
 * Works with a fine-grained PAT that has Issues read/write on the target
 * repos (plus "Read access to metadata").
 */

interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  body?: string | null;
  user?: { login: string } | null;
  labels?: Array<{ name?: string } | string>;
  comments?: number;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
}

interface GitHubComment {
  user?: { login: string } | null;
  body?: string | null;
  created_at: string;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export class GitHubConnector implements Connector {
  readonly id = "github";
  private log!: Logger;
  private api!: HttpJson;
  private selfLogin = "";
  private repos: string[] = [];
  private pollMs = 60_000;
  /** repo#number → epoch ms of the agent's own last write, for loop suppression. */
  private readonly selfActions = new Map<string, number>();

  constructor(private readonly fetchImpl?: FetchLike) {}

  async init(ctx: ConnectorContext): Promise<void> {
    this.log = ctx.log.child({ scope: "connector", connector: this.id });
    const token = ctx.config.token;
    if (!token) {
      throw new ConnectorError(this.id, "missing GITHUB_TOKEN (fine-grained PAT with Issues read/write)");
    }
    this.repos = (ctx.config.repos ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    for (const repo of this.repos) {
      if (!REPO_RE.test(repo)) throw new ConnectorError(this.id, `invalid repo in GITHUB_REPOS: "${repo}" (use owner/name)`);
    }
    const pollSeconds = Number(ctx.config.pollSeconds ?? 60);
    this.pollMs = Math.max(15, pollSeconds) * 1000;

    this.api = new HttpJson({
      connector: this.id,
      baseUrl: "https://api.github.com",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "exempclaw",
      },
      fetchImpl: this.fetchImpl,
    });

    const me = await this.api.get<{ login: string }>("/user");
    this.selfLogin = me.login;
    this.log.info("github connected", { as: me.login, repos: this.repos.join(",") || "none" });
  }

  private resolveRepo(repo?: string): string {
    const resolved = repo ?? this.repos[0];
    if (!resolved) {
      throw new ConnectorError(this.id, "no repo given and GITHUB_REPOS is not configured");
    }
    if (!REPO_RE.test(resolved)) throw new ConnectorError(this.id, `invalid repo "${resolved}" (use owner/name)`);
    return resolved;
  }

  tools(): Tool[] {
    const listIssues = defineTool({
      name: "github_list_issues",
      description: "List recent issues in a repository, most recently updated first.",
      schema: z.object({
        repo: z.string().optional().describe("owner/name; defaults to the first configured repo."),
        state: z.enum(["open", "closed", "all"]).default("open"),
        limit: z.number().int().min(1).max(50).default(20),
        includePullRequests: z.boolean().default(false),
      }),
      execute: async (input, ctx) => {
        const repo = this.resolveRepo(input.repo);
        const issues = await this.api.get<GitHubIssue[]>(`/repos/${repo}/issues`, {
          query: { state: input.state, sort: "updated", direction: "desc", per_page: input.limit },
          signal: ctx.signal,
        });
        const filtered = issues.filter((i) => input.includePullRequests || !i.pull_request);
        if (filtered.length === 0) return { content: `No ${input.state} issues in ${repo}.` };
        return {
          content: filtered
            .map(
              (i) =>
                `#${i.number} [${i.state}]${i.pull_request ? " [PR]" : ""} ${i.title} (by ${i.user?.login ?? "?"}, updated ${i.updated_at})${renderLabels(i)}`,
            )
            .join("\n"),
        };
      },
    });

    const readIssue = defineTool({
      name: "github_read_issue",
      description: "Read one issue or pull request, including its recent comments.",
      schema: z.object({
        repo: z.string().optional(),
        number: z.number().int().min(1),
      }),
      execute: async (input, ctx) => {
        const repo = this.resolveRepo(input.repo);
        const issue = await this.api.get<GitHubIssue>(`/repos/${repo}/issues/${input.number}`, {
          signal: ctx.signal,
        });
        const comments = await this.api.get<GitHubComment[]>(`/repos/${repo}/issues/${input.number}/comments`, {
          query: { per_page: 30 },
          signal: ctx.signal,
        });
        const lines = [
          `#${issue.number} [${issue.state}] ${issue.title}`,
          `by ${issue.user?.login ?? "?"} · created ${issue.created_at} · updated ${issue.updated_at}${renderLabels(issue)}`,
          issue.html_url,
          "",
          truncate(issue.body ?? "(no description)", 4000),
        ];
        if (comments.length > 0) {
          lines.push("", `--- comments (${comments.length}) ---`);
          for (const c of comments) {
            lines.push(`[${c.created_at}] ${c.user?.login ?? "?"}: ${truncate(c.body ?? "", 1500)}`);
          }
        }
        return { content: lines.join("\n") };
      },
    });

    const comment = defineTool({
      name: "github_comment",
      description: "Comment on an issue or pull request. Acts outward; requires approval.",
      outward: true,
      schema: z.object({
        repo: z.string().optional(),
        number: z.number().int().min(1),
        body: z.string().min(1),
      }),
      execute: async (input, ctx) => {
        const repo = this.resolveRepo(input.repo);
        const res = await this.api.post<{ html_url: string }>(`/repos/${repo}/issues/${input.number}/comments`, {
          body: { body: input.body },
          signal: ctx.signal,
        });
        this.recordSelfAction(repo, input.number);
        return { content: `Commented on ${repo}#${input.number}: ${res.html_url}` };
      },
    });

    const createIssue = defineTool({
      name: "github_create_issue",
      description: "Open a new issue. Acts outward; requires approval.",
      outward: true,
      schema: z.object({
        repo: z.string().optional(),
        title: z.string().min(1),
        body: z.string().default(""),
        labels: z.array(z.string()).default([]),
      }),
      execute: async (input, ctx) => {
        const repo = this.resolveRepo(input.repo);
        const res = await this.api.post<{ number: number; html_url: string }>(`/repos/${repo}/issues`, {
          body: { title: input.title, body: input.body, ...(input.labels.length ? { labels: input.labels } : {}) },
          signal: ctx.signal,
        });
        this.recordSelfAction(repo, res.number);
        return { content: `Created ${repo}#${res.number}: ${res.html_url}` };
      },
    });

    return [listIssues, readIssue, comment, createIssue];
  }

  /** Polls configured repos for updated issues and surfaces them as events. */
  async listen(onEvent: (event: InboundEvent) => void, signal: AbortSignal): Promise<void> {
    if (this.repos.length === 0) {
      this.log.warn("GITHUB_REPOS not set — github inbound events disabled (tools still work)");
      return;
    }
    // Start from "now": don't replay the backlog on every restart.
    let since = new Date().toISOString();
    this.log.info("github polling started", { repos: this.repos.join(","), everyMs: this.pollMs });

    while (!signal.aborted) {
      await sleep(this.pollMs, signal);
      if (signal.aborted) break;
      const cycleStart = new Date().toISOString();
      for (const repo of this.repos) {
        try {
          const issues = await this.api.get<GitHubIssue[]>(`/repos/${repo}/issues`, {
            query: { state: "all", sort: "updated", direction: "desc", per_page: 20, since },
            signal,
          });
          for (const issue of issues) {
            const event = this.issueToInbound(repo, issue, since);
            if (event) onEvent(event);
          }
        } catch (err) {
          if (signal.aborted) break;
          this.log.warn("github poll failed", { repo, error: (err as Error).message });
        }
      }
      since = cycleStart;
    }
  }

  /** Maps an updated issue to an InboundEvent, suppressing our own echoes. */
  issueToInbound(repo: string, issue: GitHubIssue, since: string): InboundEvent | null {
    if (this.isRecentSelfAction(repo, issue.number)) return null;
    const isNew = issue.created_at >= since;
    if (isNew && issue.user?.login === this.selfLogin) return null;
    return {
      connector: this.id,
      type: isNew ? "github.issue_opened" : "github.issue_updated",
      eventId: `${repo}#${issue.number}@${issue.updated_at}`,
      threadId: `${repo}#${issue.number}`,
      summary: [
        `${isNew ? "New" : "Updated"} ${issue.pull_request ? "pull request" : "issue"} ${repo}#${issue.number}: ${issue.title}`,
        `state=${issue.state} author=${issue.user?.login ?? "?"} updated=${issue.updated_at}`,
        `Read it with github_read_issue (repo="${repo}", number=${issue.number}) before deciding whether to act.`,
        isNew && issue.body ? `\n${truncate(issue.body, 1500)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      payload: issue,
      receivedAt: new Date().toISOString(),
    };
  }

  private recordSelfAction(repo: string, number: number): void {
    this.selfActions.set(`${repo}#${number}`, Date.now());
  }

  /** True if the agent itself just wrote to this issue (poll echo window). */
  isRecentSelfAction(repo: string, number: number, now = Date.now()): boolean {
    const at = this.selfActions.get(`${repo}#${number}`);
    return at !== undefined && now - at < 2 * this.pollMs;
  }
}

function renderLabels(issue: GitHubIssue): string {
  const names = (issue.labels ?? [])
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter(Boolean);
  return names.length ? ` [${names.join(", ")}]` : "";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
