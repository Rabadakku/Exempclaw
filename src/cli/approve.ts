import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { ApprovalRequest } from "../tools/tool.js";

/**
 * Terminal-based approver used when EXEMPCLAW_ACTION_POLICY=ask. Prints the
 * pending outward action and blocks for a y/N decision. Swap this for a web or
 * Slack approver by passing a different function into the orchestrator.
 */
export async function terminalApprover(req: ApprovalRequest): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`\n\x1b[33m⚠  Approval required\x1b[0m — ${req.summary}\n`);
    stdout.write(`   tool: ${req.tool}\n`);
    stdout.write(`   ${req.detail.replace(/\n/g, "\n   ")}\n`);
    const answer = (await rl.question("   Approve this action? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
