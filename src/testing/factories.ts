import type Anthropic from "@anthropic-ai/sdk";
import type { ClaudeLike, ClaudeTurnParams } from "../llm/claude.js";
import type { MemoryEntry, MemoryStore } from "../memory/store.js";
import { createLogger, type Logger } from "../core/logger.js";

/** Shared test doubles. Not shipped — excluded from the build. */

export function quietLogger(): Logger {
  return createLogger("error");
}

export function makeMessage(opts: {
  content: Anthropic.ContentBlock[] | string;
  stopReason?: Anthropic.StopReason;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): Anthropic.Message {
  const content: Anthropic.ContentBlock[] =
    typeof opts.content === "string"
      ? [{ type: "text", text: opts.content, citations: null } as Anthropic.TextBlock]
      : opts.content;
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-8",
    content,
    stop_reason: opts.stopReason ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens ?? 100,
      output_tokens: opts.outputTokens ?? 50,
      cache_creation_input_tokens: opts.cacheWrite ?? 0,
      cache_read_input_tokens: opts.cacheRead ?? 0,
    },
  } as unknown as Anthropic.Message;
}

export function toolUseBlock(id: string, name: string, input: unknown): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ToolUseBlock;
}

export interface ScriptedClaude extends ClaudeLike {
  calls: ClaudeTurnParams[];
  summarizeCalls: string[];
}

/**
 * A ClaudeLike that replays a fixed script of responses. If the script runs
 * out, the last entry repeats (useful for max-iteration tests).
 */
export function scriptedClaude(script: Anthropic.Message[], summary = "SUMMARY"): ScriptedClaude {
  const calls: ClaudeTurnParams[] = [];
  const summarizeCalls: string[] = [];
  return {
    calls,
    summarizeCalls,
    async turn(params: ClaudeTurnParams): Promise<Anthropic.Message> {
      calls.push(params);
      const index = Math.min(calls.length - 1, script.length - 1);
      const message = script[index];
      if (!message) throw new Error("scriptedClaude: empty script");
      return message;
    },
    async summarize(text: string): Promise<string> {
      summarizeCalls.push(text);
      return summary;
    },
  };
}

/** In-memory MemoryStore for tests. */
export class InMemoryStore implements MemoryStore {
  memories: MemoryEntry[] = [];
  history: Anthropic.MessageParam[] = [];
  private counter = 0;

  async addMemory(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    const full: MemoryEntry = { ...entry, id: `mem-${++this.counter}`, createdAt: new Date().toISOString() };
    this.memories.push(full);
    return full;
  }

  async searchMemory(query: string, limit = 10): Promise<MemoryEntry[]> {
    const q = query.toLowerCase();
    return this.memories.filter((m) => m.text.toLowerCase().includes(q)).slice(0, limit);
  }

  async allMemories(): Promise<MemoryEntry[]> {
    return [...this.memories];
  }

  async removeMemory(id: string): Promise<boolean> {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => m.id !== id);
    return this.memories.length < before;
  }

  async loadHistory(): Promise<Anthropic.MessageParam[]> {
    return structuredClone(this.history);
  }

  async saveHistory(messages: Anthropic.MessageParam[]): Promise<void> {
    this.history = structuredClone(messages);
  }

  async clearHistory(): Promise<void> {
    this.history = [];
  }
}
