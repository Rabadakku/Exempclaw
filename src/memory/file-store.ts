import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { MemoryEntry, MemoryStore } from "./store.js";

/**
 * Default MemoryStore backed by JSON files on disk. Simple, dependency-free,
 * and good enough to run real agents; swap for SQLite + a vector index when
 * retrieval needs to scale. One directory per agent under <dataDir>/agents/<id>.
 *
 * Writes go through a temp file + rename so a crash mid-write can't corrupt
 * the store. Mutations are serialized behind a per-store queue so concurrent
 * tool calls can't interleave read-modify-write cycles.
 */
export class FileMemoryStore implements MemoryStore {
  private readonly memoryPath: string;
  private readonly historyPath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, agentId: string) {
    const base = join(dataDir, "agents", agentId);
    this.memoryPath = join(base, "memory.json");
    this.historyPath = join(base, "history.json");
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw err;
    }
  }

  private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await rename(tmp, path);
  }

  /** Serializes a mutation behind the store's write queue. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.catch(() => undefined).then(op);
    this.writeQueue = next;
    return next;
  }

  addMemory(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    return this.enqueue(async () => {
      const memories = await this.allMemories();
      const full: MemoryEntry = { ...entry, id: randomUUID(), createdAt: new Date().toISOString() };
      memories.push(full);
      await this.writeJsonAtomic(this.memoryPath, memories);
      return full;
    });
  }

  removeMemory(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const memories = await this.allMemories();
      const remaining = memories.filter((m) => m.id !== id && !m.id.startsWith(id));
      if (remaining.length === memories.length) return false;
      await this.writeJsonAtomic(this.memoryPath, remaining);
      return true;
    });
  }

  async searchMemory(query: string, limit = 10): Promise<MemoryEntry[]> {
    const memories = await this.allMemories();
    const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1))];
    if (terms.length === 0) return memories.slice(-limit).reverse();

    // Term-frequency scoring with a tag/source boost and recency tiebreak.
    const scored = memories.map((m) => {
      const text = m.text.toLowerCase();
      const meta = `${m.tags.join(" ")} ${m.source}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        score += countOccurrences(text, term);
        if (meta.includes(term)) score += 2;
      }
      return { m, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.m.createdAt.localeCompare(a.m.createdAt))
      .slice(0, limit)
      .map((s) => s.m);
  }

  allMemories(): Promise<MemoryEntry[]> {
    return this.readJson<MemoryEntry[]>(this.memoryPath, []);
  }

  loadHistory(): Promise<Anthropic.MessageParam[]> {
    return this.readJson<Anthropic.MessageParam[]>(this.historyPath, []);
  }

  saveHistory(messages: Anthropic.MessageParam[]): Promise<void> {
    return this.enqueue(() => this.writeJsonAtomic(this.historyPath, messages));
  }

  clearHistory(): Promise<void> {
    return this.enqueue(async () => {
      await rm(this.historyPath, { force: true });
    });
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
