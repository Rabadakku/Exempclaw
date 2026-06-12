import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Persisted at-least-once dedup for inbound events. Connectors may redeliver
 * (Slack retries unacked envelopes, polls overlap, processes restart); the
 * orchestrator drops anything whose event id it has already dispatched.
 * Keeps a bounded FIFO of recent keys per agent, persisted to disk.
 */
export class SeenEvents {
  private readonly path: string;
  private keys: string[] = [];
  private readonly index = new Set<string>();
  private loaded = false;
  private persistTimer?: NodeJS.Timeout;

  constructor(
    dataDir: string,
    agentId: string,
    private readonly capacity = 500,
  ) {
    this.path = join(dataDir, "agents", agentId, "seen-events.json");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stored = JSON.parse(await readFile(this.path, "utf8")) as string[];
      this.keys = stored.slice(-this.capacity);
      for (const key of this.keys) this.index.add(key);
    } catch {
      // missing or corrupt file — start fresh
    }
  }

  /** Returns true the first time a key is seen; false on duplicates. */
  async markSeen(key: string): Promise<boolean> {
    await this.load();
    if (this.index.has(key)) return false;
    this.keys.push(key);
    this.index.add(key);
    while (this.keys.length > this.capacity) {
      const evicted = this.keys.shift();
      if (evicted) this.index.delete(evicted);
    }
    this.schedulePersist();
    return true;
  }

  /** Debounced write so event bursts don't thrash the disk. */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, 250);
    this.persistTimer.unref?.();
  }

  async persist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(this.keys), "utf8");
    await rename(tmp, this.path);
  }
}
