import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Logger } from "../core/logger.js";
import { ExempclawError } from "../core/errors.js";

/**
 * Thin wrapper over the Anthropic SDK. Centralizes model defaults, adaptive
 * thinking, prompt caching, streaming, and refusal handling so the agent
 * runtime never touches the SDK directly. Claude is the ONLY provider
 * Exempclaw uses — there is no abstraction layer for other LLMs by design.
 */

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeTurnParams {
  model?: string;
  /**
   * System prompt blocks. Place `cache_control` on the last *stable* block
   * (see persona.buildSystemBlocks) so the tools+persona prefix is cached.
   */
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.ToolUnion[];
  /** Caps a single response. Default 64000 (streamed). */
  maxTokens?: number;
  /** Controls reasoning depth + token spend. Defaults to "high". */
  effort?: EffortLevel;
  /** Cooperative cancellation — aborts the in-flight HTTP request. */
  signal?: AbortSignal;
  /** Receives text deltas as they stream, for live terminal output. */
  onText?: (delta: string) => void;
  /**
   * Adds a cache breakpoint on the last message so the whole conversation
   * prefix is reusable next turn. On by default for the agent loop.
   */
  cacheConversation?: boolean;
}

export class RefusalError extends ExempclawError {
  readonly category: string | null;
  constructor(category: string | null, explanation?: string | null) {
    super(`Claude declined the request${category ? ` (${category})` : ""}${explanation ? `: ${explanation}` : ""}`);
    this.category = category;
  }
}

/**
 * The surface the agent runtime depends on. ClaudeClient implements it; tests
 * substitute a scripted double.
 */
export interface ClaudeLike {
  turn(params: ClaudeTurnParams): Promise<Anthropic.Message>;
  summarize(text: string, opts?: { model?: string; instruction?: string; signal?: AbortSignal }): Promise<string>;
}

export class ClaudeClient implements ClaudeLike {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly defaultModel: string,
    private readonly log: Logger,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 4 });
  }

  /**
   * Runs a single assistant turn (streamed). Returns the full Message so the
   * caller can inspect stop_reason, tool_use blocks, and usage. Throws
   * RefusalError if the safety classifiers decline (possible on Fable 5).
   */
  async turn(params: ClaudeTurnParams): Promise<Anthropic.Message> {
    const model = params.model || this.defaultModel;
    const request: Anthropic.MessageStreamParams = {
      model,
      max_tokens: params.maxTokens ?? 64000,
      system: params.system,
      messages: params.cacheConversation ? withConversationBreakpoint(params.messages) : params.messages,
      thinking: { type: "adaptive" },
      output_config: { effort: params.effort ?? "high" },
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    };

    const stream = this.client.messages.stream(request, { signal: params.signal });
    if (params.onText) stream.on("text", params.onText);
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      throw new RefusalError(message.stop_details?.category ?? null, message.stop_details?.explanation);
    }

    this.log.debug("claude turn complete", {
      model,
      stop_reason: message.stop_reason ?? "unknown",
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      cache_read: message.usage.cache_read_input_tokens ?? 0,
    });

    return message;
  }

  /**
   * One-shot structured extraction: constrains the response to `schema` via
   * structured outputs, parses, and validates. Used by the ingestion pipeline.
   */
  async extract<T>(opts: {
    prompt: string;
    schema: z.ZodType<T>;
    system?: string;
    model?: string;
    effort?: EffortLevel;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<{ value: T; usage: Anthropic.Usage }> {
    const model = opts.model || this.defaultModel;
    const jsonSchema = z.toJSONSchema(opts.schema, { target: "draft-7" }) as Record<string, unknown>;

    const stream = this.client.messages.stream(
      {
        model,
        max_tokens: opts.maxTokens ?? 16000,
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: "user", content: opts.prompt }],
        thinking: { type: "adaptive" },
        output_config: {
          effort: opts.effort ?? "medium",
          format: { type: "json_schema", schema: jsonSchema },
        },
      },
      { signal: opts.signal },
    );
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      throw new RefusalError(message.stop_details?.category ?? null, message.stop_details?.explanation);
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = opts.schema.safeParse(parseJsonLenient(text));
    if (!parsed.success) {
      throw new ExempclawError(`structured extraction did not match schema: ${parsed.error.message}`, {
        retryable: true,
      });
    }
    return { value: parsed.data, usage: message.usage };
  }

  /** Cheap one-shot summarization, used for history compaction. */
  async summarize(
    text: string,
    opts: { model?: string; instruction?: string; signal?: AbortSignal } = {},
  ): Promise<string> {
    const instruction =
      opts.instruction ??
      "Summarize this agent conversation transcript for the agent's own future reference. Preserve: open commitments and deadlines, key facts and decisions, people and their roles, unresolved threads, and anything the agent promised to do. Omit pleasantries and tool mechanics. Write it as dense factual notes.";
    const message = await this.turn({
      model: opts.model,
      system: [{ type: "text", text: "You produce dense, factual summaries. No preamble." }],
      messages: [{ role: "user", content: `${instruction}\n\n<transcript>\n${text}\n</transcript>` }],
      effort: "low",
      maxTokens: 4000,
      signal: opts.signal,
    });
    return message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }

  /** Verifies the API key + model are usable. Used by `exempclaw doctor`. */
  async ping(model?: string): Promise<{ id: string; displayName: string }> {
    const info = await this.client.models.retrieve(model || this.defaultModel);
    return { id: info.id, displayName: info.display_name };
  }
}

/**
 * Returns a copy of `messages` with a cache breakpoint on the final content
 * block, so the entire conversation prefix is served from cache next turn.
 * The caller's array is not mutated.
 */
export function withConversationBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1]!;
  const cacheControl: Anthropic.CacheControlEphemeral = { type: "ephemeral" };

  if (typeof last.content === "string") {
    out[out.length - 1] = {
      ...last,
      content: [{ type: "text", text: last.content, cache_control: cacheControl }],
    };
    return out;
  }

  const blocks = last.content.slice();
  const lastBlock = blocks[blocks.length - 1];
  if (!lastBlock) return messages;
  // Only block types that accept cache_control; skip exotic blocks rather than error.
  if (
    lastBlock.type === "text" ||
    lastBlock.type === "tool_result" ||
    lastBlock.type === "tool_use" ||
    lastBlock.type === "image" ||
    lastBlock.type === "document"
  ) {
    blocks[blocks.length - 1] = { ...lastBlock, cache_control: cacheControl };
    out[out.length - 1] = { ...last, content: blocks };
    return out;
  }
  return messages;
}

/** Parses model-produced JSON, tolerating markdown code fences. */
export function parseJsonLenient(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
