import { z } from "zod";
import type { Connector, ConnectorContext, InboundEvent } from "../connector.js";
import { defineTool, type Tool } from "../../tools/tool.js";
import type { Logger } from "../../core/logger.js";

/** GitHub connector stub. Wire up @octokit/rest + webhooks behind these methods. */
export class GitHubConnector implements Connector {
  readonly id = "github";
  private log!: Logger;

  async init(ctx: ConnectorContext): Promise<void> {
    this.log = ctx.log.child({ scope: "connector", connector: this.id });
    this.log.info("github connector initialized (stub)");
  }

  tools(): Tool[] {
    const listIssues = defineTool({
      name: "github_list_issues",
      description: "List open issues assigned to or relevant to the agent's role.",
      schema: z.object({ repo: z.string().describe("owner/repo"), limit: z.number().int().min(1).max(100).default(20) }),
      async execute(input) {
        return { content: `(stub) no issues for ${input.repo}` };
      },
    });

    const comment = defineTool({
      name: "github_comment",
      description: "Comment on an issue or pull request. Acts outward; requires approval.",
      outward: true,
      schema: z.object({ repo: z.string(), number: z.number().int(), body: z.string() }),
      async execute(input, ctx) {
        ctx.log.info("github_comment (stub)", { repo: input.repo, number: input.number });
        return { content: `(stub) would comment on ${input.repo}#${input.number}` };
      },
    });

    return [listIssues, comment];
  }

  async listen(onEvent: (event: InboundEvent) => void, signal: AbortSignal): Promise<void> {
    void onEvent;
    void signal;
    this.log.debug("github listen() is a stub");
  }
}
