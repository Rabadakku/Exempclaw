import type Anthropic from "@anthropic-ai/sdk";

/**
 * A single durable memory: a fact, lesson, or piece of context the agent
 * accumulated. Kept deliberately small and atomic so retrieval can be selective.
 */
export interface MemoryEntry {
  id: string;
  /** Where it came from: "email", "slack", "onboarding", "self", … */
  source: string;
  /** Free-text content of the memory. */
  text: string;
  /** Optional tags for retrieval/filtering. */
  tags: string[];
  createdAt: string;
}

/**
 * Persistence boundary for a single agent's state. The agent runtime depends on
 * this interface only — back it with files (default), SQLite, Postgres, or a
 * vector DB without touching the runtime.
 */
export interface MemoryStore {
  /** Durable knowledge / context. */
  addMemory(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry>;
  /** Naive retrieval for the foundation; replace with embeddings later. */
  searchMemory(query: string, limit?: number): Promise<MemoryEntry[]>;
  allMemories(): Promise<MemoryEntry[]>;

  /** Conversation/episodic history — the running message transcript. */
  loadHistory(): Promise<Anthropic.MessageParam[]>;
  saveHistory(messages: Anthropic.MessageParam[]): Promise<void>;
}
