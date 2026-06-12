import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { ClaudeLike, EffortLevel } from "../llm/claude.js";
import type { Logger } from "../core/logger.js";
import { ToolExecutionError } from "../core/errors.js";
import { addUsage, contextTokens, emptyUsage, estimateCostUsd, type UsageTotals } from "../core/usage.js";
import type { RunLog, TriggerKind, OutwardActionRecord } from "../core/run-log.js";
import type { MemoryStore } from "../memory/store.js";
import { compactHistory } from "../memory/compaction.js";
import {
  evaluatePolicy,
  resolvePolicy,
  type AgentActivity,
  type ApprovalRequest,
  type Tool,
  type ToolContext,
  type ToolRegistry,
} from "../tools/tool.js";
import type { ActionPolicy } from "../config/index.js";
import { buildSystemBlocks, type Persona } from "./persona.js";

export interface AgentOptions {
  id: string;
  persona: Persona;
  model: string;
  effort?: EffortLevel;
  /** Hard cap on tool-use iterations per run, to bound runaway loops. */
  maxIterations?: number;
  /** Per-tool approval-policy overrides; "*" matches any tool. */
  toolPolicies?: Record<string, ActionPolicy>;
  /** Compact history once the prompt grows past this many tokens. */
  contextBudgetTokens?: number;
}

export interface AgentDeps {
  claude: ClaudeLike;
  tools: ToolRegistry;
  memory: MemoryStore;
  log: Logger;
  actionPolicy: ActionPolicy;
  /** Interactive approver invoked when policy is "ask" and a tool is outward. */
  approve: (req: ApprovalRequest) => Promise<boolean>;
  /** Audit trail; runs are recorded when provided. */
  runLog?: RunLog;
}

/** Live-progress callbacks for terminal UX. All optional. */
export interface RunHooks {
  /** A model turn is starting (1-based). Show a thinking indicator. */
  onTurnStart?: (iteration: number) => void;
  onText?: (delta: string) => void;
  onToolStart?: (name: string, input: unknown) => void;
  onToolEnd?: (name: string, ok: boolean, detail?: string) => void;
  /** The agent called display_status — play the matching animation. */
  onStatus?: (activity: AgentActivity, message: string) => void;
}

export interface RunOptions {
  signal?: AbortSignal;
  hooks?: RunHooks;
  trigger?: { kind: TriggerKind; detail?: string };
}

export interface RunResult {
  runId: string;
  /** The final assistant text after the loop settled. */
  text: string;
  iterations: number;
  stopReason: string | null;
  usage: UsageTotals;
  costUsd: number | null;
}

/**
 * A single agent instance. Owns the Claude tool-use loop: send the conversation,
 * execute any tool calls (gating outward ones through the approval policy), feed
 * results back, and repeat until the model stops calling tools. History is
 * persisted to the MemoryStore after every run so agents survive restarts, and
 * every run is appended to the audit log.
 */
export class Agent {
  private readonly log: Logger;
  private readonly maxIterations: number;
  private readonly contextBudgetTokens: number;

  constructor(
    private readonly opts: AgentOptions,
    private readonly deps: AgentDeps,
  ) {
    this.log = deps.log.child({ scope: "agent", agentId: opts.id });
    this.maxIterations = opts.maxIterations ?? 25;
    this.contextBudgetTokens = opts.contextBudgetTokens ?? 200_000;
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
  async run(userInput: string, options: RunOptions = {}): Promise<RunResult> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const signal = options.signal ?? new AbortController().signal;
    const hooks = options.hooks ?? {};
    const outwardActions: OutwardActionRecord[] = [];

    const messages = await this.deps.memory.loadHistory();
    messages.push({ role: "user", content: userInput });

    const system = await this.composeSystemBlocks();
    const tools = this.deps.tools.toAnthropicTools();

    let iterations = 0;
    let stopReason: string | null = null;
    let finalText = "";
    let usage = emptyUsage();
    let lastContextTokens = 0;
    let runError: string | undefined;

    try {
      while (iterations < this.maxIterations) {
        if (signal.aborted) {
          stopReason = stopReason ?? "interrupted";
          break;
        }
        iterations++;
        hooks.onTurnStart?.(iterations);

        let message: Anthropic.Message;
        try {
          message = await this.deps.claude.turn({
            model: this.opts.model,
            system,
            messages,
            tools,
            effort: this.opts.effort,
            signal,
            onText: hooks.onText,
            cacheConversation: true,
          });
        } catch (err) {
          if (signal.aborted) {
            // Operator interrupt — settle gracefully, keep what we have.
            stopReason = "interrupted";
            iterations--;
            break;
          }
          throw err;
        }
        stopReason = message.stop_reason;
        usage = addUsage(usage, message.usage);
        lastContextTokens = contextTokens(message.usage);

        messages.push({ role: "assistant", content: message.content });
        finalText = this.extractText(message.content) || finalText;

        // Server-side pause: re-send the conversation so the API resumes.
        if (message.stop_reason === "pause_turn") continue;

        const toolUses = message.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );
        if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
          break;
        }

        const results = await this.executeToolCalls(toolUses, signal, hooks, outwardActions);
        messages.push({ role: "user", content: results });
      }
    } catch (err) {
      runError = (err as Error).message;
      throw err;
    } finally {
      let toSave = messages;
      if (lastContextTokens > this.contextBudgetTokens) {
        toSave = await this.tryCompact(messages, signal);
      }
      await this.deps.memory.saveHistory(toSave);

      const costUsd = estimateCostUsd(this.opts.model, usage);
      await this.deps.runLog
        ?.append({
          runId,
          agentId: this.opts.id,
          trigger: options.trigger ?? { kind: "cli" },
          startedAt,
          finishedAt: new Date().toISOString(),
          model: this.opts.model,
          iterations,
          stopReason,
          usage,
          costUsd,
          outwardActions,
          ...(runError ? { error: runError } : {}),
        })
        .catch((err) => this.log.warn("failed to write run record", { error: (err as Error).message }));

      if (!runError) {
        this.log.info("run complete", {
          iterations,
          stopReason: stopReason ?? "none",
          tokens: usage.inputTokens + usage.outputTokens,
        });
      }
    }

    return {
      runId,
      text: finalText,
      iterations,
      stopReason,
      usage,
      costUsd: estimateCostUsd(this.opts.model, usage),
    };
  }

  private async composeSystemBlocks(): Promise<Anthropic.TextBlockParam[]> {
    const memories = await this.deps.memory.allMemories();
    const roleContext = memories
      .slice(-50) // most recent durable knowledge; bounded to keep the prompt manageable
      .map((m) => `- (${m.source}) ${m.text}`)
      .join("\n");
    return buildSystemBlocks(this.opts.persona, roleContext);
  }

  private async tryCompact(
    messages: Anthropic.MessageParam[],
    signal: AbortSignal,
  ): Promise<Anthropic.MessageParam[]> {
    try {
      const compacted = await compactHistory(messages, {
        summarize: (transcript) => this.deps.claude.summarize(transcript, { model: this.opts.model, signal }),
      });
      if (compacted !== messages) {
        this.log.info("history compacted", { from: messages.length, to: compacted.length });
      }
      return compacted;
    } catch (err) {
      this.log.warn("history compaction failed; keeping full history", { error: (err as Error).message });
      return messages;
    }
  }

  private extractText(content: Anthropic.ContentBlock[]): string {
    return content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }

  /**
   * Executes the turn's tool calls. Read-only tools run concurrently; if any
   * call is outward the whole batch runs sequentially so approval prompts
   * arrive one at a time. Result order always matches call order.
   */
  private async executeToolCalls(
    toolUses: Anthropic.ToolUseBlock[],
    signal: AbortSignal,
    hooks: RunHooks,
    outwardActions: OutwardActionRecord[],
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    const ctx: ToolContext = {
      agentId: this.opts.id,
      log: this.log,
      signal,
      // Tools that need ad-hoc approval resolve against the global policy.
      requestApproval: (req) => evaluatePolicy(this.deps.actionPolicy, req, this.deps.approve),
      emit: (event) => {
        if (event.kind === "status") hooks.onStatus?.(event.activity, event.message);
      },
    };

    const anyOutward = toolUses.some((call) => this.deps.tools.get(call.name)?.outward);
    if (anyOutward) {
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        results.push(await this.runSingleTool(call, ctx, hooks, outwardActions));
      }
      return results;
    }
    return Promise.all(toolUses.map((call) => this.runSingleTool(call, ctx, hooks, outwardActions)));
  }

  private async runSingleTool(
    call: Anthropic.ToolUseBlock,
    ctx: ToolContext,
    hooks: RunHooks,
    outwardActions: OutwardActionRecord[],
  ): Promise<Anthropic.ToolResultBlockParam> {
    const tool = this.deps.tools.get(call.name) as Tool | undefined;
    if (!tool) {
      return this.toolError(call.id, `unknown tool: ${call.name}`);
    }

    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      return this.toolError(call.id, `invalid input: ${parsed.error.message}`);
    }

    hooks.onToolStart?.(tool.name, parsed.data);

    // Gate outward actions through the approval policy before executing.
    if (tool.outward) {
      const policy = resolvePolicy(this.deps.actionPolicy, this.opts.toolPolicies, tool.name);
      const request: ApprovalRequest = {
        tool: tool.name,
        summary: `${tool.name} requested by agent ${this.opts.id}`,
        detail: JSON.stringify(parsed.data, null, 2),
      };
      const approved = await evaluatePolicy(policy, request, this.deps.approve);
      outwardActions.push({
        tool: tool.name,
        approved,
        summary: summarizeInput(parsed.data),
        at: new Date().toISOString(),
      });
      if (!approved) {
        this.log.warn("outward action denied", { tool: tool.name, policy });
        hooks.onToolEnd?.(tool.name, false, "denied by approval policy");
        return this.toolError(call.id, "action denied by approval policy");
      }
    }

    try {
      this.log.debug("executing tool", { tool: tool.name });
      const result = await tool.execute(parsed.data, ctx);
      hooks.onToolEnd?.(tool.name, !result.isError);
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      };
    } catch (err) {
      const message = err instanceof ToolExecutionError ? err.message : `unexpected error: ${(err as Error).message}`;
      this.log.error("tool threw", { tool: tool.name, error: message });
      hooks.onToolEnd?.(tool.name, false, message);
      return this.toolError(call.id, message);
    }
  }

  private toolError(toolUseId: string, message: string): Anthropic.ToolResultBlockParam {
    return { type: "tool_result", tool_use_id: toolUseId, content: message, is_error: true };
  }
}

/** One-line description of a tool input for the audit record. */
function summarizeInput(input: unknown): string {
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}
