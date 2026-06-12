import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { UsageTotals } from "./usage.js";

/**
 * Append-only audit trail of agent runs. One JSONL file per agent under
 * <dataDir>/agents/<id>/runs.jsonl. This is the substrate for the `costs`
 * command and for answering "what did this agent do, and who approved it".
 */

export type TriggerKind = "cli" | "chat" | "event" | "schedule" | "ingest";

export interface OutwardActionRecord {
  tool: string;
  approved: boolean;
  summary: string;
  at: string;
}

export interface RunRecord {
  runId: string;
  agentId: string;
  trigger: { kind: TriggerKind; detail?: string };
  startedAt: string;
  finishedAt: string;
  model: string;
  iterations: number;
  stopReason: string | null;
  usage: UsageTotals;
  costUsd: number | null;
  outwardActions: OutwardActionRecord[];
  error?: string;
}

export class RunLog {
  private readonly path: string;

  constructor(dataDir: string, agentId: string) {
    this.path = join(dataDir, "agents", agentId, "runs.jsonl");
  }

  async append(record: RunRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }

  /** Reads every record, skipping lines that fail to parse (torn writes). */
  async readAll(): Promise<RunRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const records: RunRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as RunRecord);
      } catch {
        // torn or corrupt line — skip rather than fail the whole read
      }
    }
    return records;
  }
}
