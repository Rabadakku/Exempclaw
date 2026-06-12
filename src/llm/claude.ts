import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../core/logger.js";
import { ExempclawError } from "../core/errors.js";

/**
 * Thin wrapper over the Anthropic SDK. Centralizes model defaults, adaptive
 * thinking, streaming for long outputs, and refusal handling so the agent
 * runtime never touches the SDK directly. Claude is the ONLY provider Exempclaw
 * uses — there is no abstraction layer for other LLMs by design.
 */

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeTurnParams {
  model: string;
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.ToolUnion[];
  /** Default 16000 (non-stream) / 64000 (stream). Caps a single response. */
  maxTokens?: number;
  /** Controls reasoning depth + token spend. Defaults to "high". */
  effort?: EffortLevel;
  /** Stream the response (recommended for long outputs). Default true. */
  stream?: boolean;
}

export class RefusalError extends ExempclawError {
  readonly category: string | null;
  constructor(category: string | null, explanation?: string) {
    super(`Claude declined the request${category ? ` (${category})` : ""}${explanation ? `: ${explanation}` : ""}`);
    this.category = category;
  }
}

export class ClaudeClient {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly defaultModel: string,
    private readonly log: Logger,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Runs a single assistant turn. Returns the full Message so the caller can
   * inspect stop_reason, tool_use blocks, and usage. Throws RefusalError if the
   * safety classifiers decline (only possible on Fable 5 and similar).
   */
  async turn(params: ClaudeTurnParams): Promise<Anthropic.Message> {
    const model = params.model || this.defaultModel;
    const stream = params.stream ?? true;
    const maxTokens = params.maxTokens ?? (stream ? 64000 : 16000);
    const effort = params.effort ?? "high";

    const baseRequest: Anthropic.MessageCreateParams = {
      model,
      max_tokens: maxTokens,
      system: params.system,
      messages: params.messages,
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    };

    // Adaptive thinking + effort are the recommended controls for the current
    // Claude family. They are accepted by the API ahead of the installed SDK's
    // typings, so they are merged forward-compatibly here.
    const request = {
      ...baseRequest,
      thinking: { type: "adaptive" },
      output_config: { effort },
    } as unknown as Anthropic.MessageCreateParams;

    let message: Anthropic.Message;
    if (stream) {
      const s = this.client.messages.stream(request);
      message = await s.finalMessage();
    } else {
      message = await this.client.messages.create({ ...request, stream: false });
    }

    if (message.stop_reason === "refusal") {
      const details = (message as { stop_details?: { category?: string; explanation?: string } | null })
        .stop_details;
      throw new RefusalError(details?.category ?? null, details?.explanation);
    }

    this.log.debug("claude turn complete", {
      model,
      stop_reason: message.stop_reason ?? "unknown",
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
    });

    return message;
  }
}
