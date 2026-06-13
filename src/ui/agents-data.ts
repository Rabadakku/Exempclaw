import { RunLog } from "../core/run-log.js";

export interface AgentActivity {
  runs: number;
  lastRunAt: string | undefined;
  totalCostUsd: number;
}

export async function agentActivity(dataDir: string, agentId: string): Promise<AgentActivity> {
  const records = await new RunLog(dataDir, agentId).readAll();
  let lastRunAt: string | undefined;
  let totalCostUsd = 0;
  for (const record of records) {
    if (!lastRunAt || record.startedAt > lastRunAt) lastRunAt = record.startedAt;
    totalCostUsd += record.costUsd ?? 0;
  }
  return { runs: records.length, lastRunAt, totalCostUsd };
}

export function timeAgo(iso: string | undefined, now: () => number = Date.now): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.floor((now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
