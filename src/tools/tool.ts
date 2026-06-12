import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../core/logger.js";
import type { ActionPolicy } from "../config/index.js";

/**
 * Context handed to every tool at execution time. Tools never read global
 * state directly — everything they need comes through here, which keeps them
 * unit-testable and lets the orchestrator scope resources per agent.
 */
export interface ToolContext {
  agentId: string;
  log: Logger;
  /** Resolve an outward-action approval. The runtime wires this to the policy + UI. */
  requestApproval(action: ApprovalRequest): Promise<boolean>;
  /** Shared signal for cooperative cancellation. */
  signal: AbortSignal;
}

export interface ApprovalRequest {
  /** Short human label, e.g. "Send email to jane@acme.com". */
  summary: string;
  /** Full detail shown to the approver (the email body, the Slack message, …). */
  detail: string;
  tool: string;
}

/**
 * A capability the agent can invoke. `input` is validated with a Zod schema,
 * which doubles as the JSON Schema sent to Claude. Mark `outward: true` for
 * anything that affects the world outside Exempclaw (sending, posting, writing
 * to external systems) so the approval gate engages.
 */
export interface Tool<I = unknown> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<I>;
  /** True if executing this tool acts on the outside world (needs approval). */
  readonly outward: boolean;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolResult {
  /** Text returned to the model as the tool_result content. */
  content: string;
  /** Marks the result as an error so the model knows the call failed. */
  isError?: boolean;
}

/** Helper to declare a tool with full type inference from its Zod schema. */
export function defineTool<I>(spec: {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  outward?: boolean;
  execute: (input: I, ctx: ToolContext) => Promise<ToolResult>;
}): Tool<I> {
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    outward: spec.outward ?? false,
    execute: spec.execute,
  };
}

/** Registry of the tools available to a single agent. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as Tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Renders the registered tools into the Anthropic tool-definition format. */
  toAnthropicTools(): Anthropic.Tool[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: z.toJSONSchema(tool.schema, { target: "draft-7" }) as Anthropic.Tool.InputSchema,
    }));
  }

  get size(): number {
    return this.tools.size;
  }
}

/**
 * Decides whether an outward action proceeds, given the deployment policy.
 * "deny" blocks unconditionally, "auto" allows, "ask" defers to the supplied
 * interactive approver (terminal prompt, web UI, Slack button, …).
 */
export async function evaluatePolicy(
  policy: ActionPolicy,
  request: ApprovalRequest,
  interactiveApprover: (req: ApprovalRequest) => Promise<boolean>,
): Promise<boolean> {
  switch (policy) {
    case "auto":
      return true;
    case "deny":
      return false;
    case "ask":
      return interactiveApprover(request);
  }
}

/**
 * Resolves the effective policy for one tool: an exact per-tool override wins,
 * then a "*" override, then the deployment-wide default. Lets an agent config
 * say e.g. auto-approve Slack thread replies while still gating email sends.
 */
export function resolvePolicy(
  globalPolicy: ActionPolicy,
  overrides: Record<string, ActionPolicy> | undefined,
  toolName: string,
): ActionPolicy {
  return overrides?.[toolName] ?? overrides?.["*"] ?? globalPolicy;
}
