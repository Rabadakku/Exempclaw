import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { MemoryEntry, MemoryStore } from "./store.js";

/**
 * Default MemoryStore backed by JSON files on disk. Simple, dependency-free,
 * and good enough to run real agents; swap for SQLite + a vector index when
 * retrieval needs to scale. One directory per agent under <dataDir>/agents/<id>.
 */
export class FileMemoryStore implements MemoryStore {
  private readonly memoryPath: string;
  private readonly historyPath: string;

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

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2), "utf8");
  }

  async addMemory(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    const memories = await this.allMemories();
    const full: MemoryEntry = { ...entry, id: randomUUID(), createdAt: new Date().toISOString() };
    memories.push(full);
    await this.writeJson(this.memoryPath, memories);
    return full;
  }

  async searchMemory(query: string, limit = 10): Promise<MemoryEntry[]> {
    const memories = await this.allMemories();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    // Naive keyword scoring + recency tiebreak. Replace with vector search later.
    const scored = memories.map((m) => {
      const haystack = `${m.text} ${m.tags.join(" ")} ${m.source}`.toLowerCase();
      const score = terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
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

  async saveHistory(messages: Anthropic.MessageParam[]): Promise<void> {
    await this.writeJson(this.historyPath, messages);
  }
}
