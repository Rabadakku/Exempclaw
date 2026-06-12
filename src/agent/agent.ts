import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeClient, type EffortLevel } from "../llm/claude.js";
import type { Logger } from "../core/logger.js";
import { ToolExecutionError } from "../core/errors.js";
import type { MemoryStore } from "../memory/store.js";
import {
  evaluatePolicy,
  type ApprovalRequest,
  type Tool,
  type ToolContext,
  type ToolRegistry,
} from "../tools/tool.js";
import type { ActionPolicy } from "../config/index.js";
import { buildSystemPrompt, type Persona } from "./persona.js";

export interface AgentOptions {
  id: string;
  persona: Persona;
  model: string;
  effort?: EffortLevel;
  /** Hard cap on tool-use iterations per run, to bound runaway loops. */
  maxIterations?: number;
}

export interface AgentDeps {
  claude: ClaudeClient;
  tools: ToolRegistry;
  memory: MemoryStore;
  log: Logger;
  actionPolicy: ActionPolicy;
  /** Interactive approver invoked when policy is "ask" and a tool is outward. */
  approve: (req: ApprovalRequest) => Promise<boolean>;
}

export interface RunResult {
  /** The final assistant text after the loop settled. */
  text: string;
  iterations: number;
  stopReason: string | null;
}

/**
 * A single agent instance. Owns the Claude tool-use loop: send the conversation,
 * execute any tool calls (gating outward ones through the approval policy), feed
 * results back, and repeat until the model stops calling tools. History is
 * persisted to the MemoryStore after every run so agents survive restarts.
 */
export class Agent {
  private readonly log: Logger;
  private readonly maxIterations: number;

  constructor(
    private readonly opts: AgentOptions,
    private readonly deps: AgentDeps,
  ) {
    this.log = deps.log.child({ scope: "agent", agentId: opts.id });
    this.maxIterations = opts.maxIterations ?? 25;
  }

  get id(): string {
    return this.opts.id;
  }

  get persona(): Persona {
    return this.opts.persona;
  }

  /**
   * Feeds one user input (a message, an incoming email, an event) into the
   * agent and runs the loop to completion.
   */
  async run(userInput: string, signal: AbortSignal = new AbortController().signal): Promise<RunResult> {
    const messages = await this.deps.memory.loadHistory();
    messages.push({ role: "user", content: userInput });

    const system = await this.composeSystemPrompt();
    const tools = this.deps.tools.toAnthropicTools();

    let iterations = 0;
    let stopReason: string | null = null;
    let finalText = "";

    while (iterations < this.maxIterations) {
      if (signal.aborted) break;
      iterations++;

      const message = await this.deps.claude.turn({
        model: this.opts.model,
        system,
        messages,
        tools,
        effort: this.opts.effort,
      });
      stopReason = message.stop_reason;

      messages.push({ role: "assistant", content: message.content });
      finalText = this.extractText(message.content) || finalText;

      const toolUses = message.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
        break;
      }

      const results = await this.executeToolCalls(toolUses, signal);
      messages.push({ role: "user", content: results });
    }

    await this.deps.memory.saveHistory(messages);
    this.log.info("run complete", { iterations, stopReason: stopReason ?? "none" });
    return { text: finalText, iterations, stopReason };
  }

  private async composeSystemPrompt(): Promise<string> {
    const memories = await this.deps.memory.allMemories();
    const roleContext = memories
      .slice(-50) // most recent durable knowledge; bounded to keep the prefix stable
      .map((m) => `- (${m.source}) ${m.text}`)
      .join("\n");
    return buildSystemPrompt(this.opts.persona, roleContext);
  }

  private extractText(content: Anthropic.ContentBlock[]): string {
    return content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }

  private async executeToolCalls(
    toolUses: Anthropic.ToolUseBlock[],
    signal: AbortSignal,
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    const ctx: ToolContext = {
      agentId: this.opts.id,
      log: this.log,
      signal,
      requestApproval: (req) => evaluatePolicy(this.deps.actionPolicy, req, this.deps.approve),
    };

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of toolUses) {
      results.push(await this.runSingleTool(call, ctx));
    }
    return results;
  }

  private async runSingleTool(
    call: Anthropic.ToolUseBlock,
    ctx: ToolContext,
  ): Promise<Anthropic.ToolResultBlockParam> {
    const tool = this.deps.tools.get(call.name) as Tool | undefined;
    if (!tool) {
      return this.toolError(call.id, `unknown tool: ${call.name}`);
    }

    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      return this.toolError(call.id, `invalid input: ${parsed.error.message}`);
    }

    // Gate outward actions through the approval policy before executing.
    if (tool.outward) {
      const approved = await ctx.requestApproval({
        tool: tool.name,
        summary: `${tool.name} requested by agent ${this.opts.id}`,
        detail: JSON.stringify(parsed.data, null, 2),
      });
      if (!approved) {
        this.log.warn("outward action denied", { tool: tool.name });
        return this.toolError(call.id, "action denied by approval policy");
      }
    }

    try {
      this.log.debug("executing tool", { tool: tool.name });
      const result = await tool.execute(parsed.data, ctx);
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      };
    } catch (err) {
      const message = err instanceof ToolExecutionError ? err.message : `unexpected error: ${(err as Error).message}`;
      this.log.error("tool threw", { tool: tool.name, error: message });
      return this.toolError(call.id, message);
    }
  }

  private toolError(toolUseId: string, message: string): Anthropic.ToolResultBlockParam {
    return { type: "tool_result", tool_use_id: toolUseId, content: message, is_error: true };
  }
}
