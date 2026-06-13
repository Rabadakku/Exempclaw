import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { RunLog, type RunRecord } from "../core/run-log.js";

export async function loadFleetHistory(dataDir: string): Promise<RunRecord[]> {
  let ids: string[];
  try {
    ids = await readdir(join(dataDir, "agents"));
  } catch {
    return [];
  }
  const all: RunRecord[] = [];
  for (const id of ids) {
    all.push(...(await new RunLog(dataDir, id).readAll()));
  }
  return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
