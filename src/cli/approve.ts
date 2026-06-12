import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { ApprovalRequest } from "../tools/tool.js";
import { bold, dim, yellow } from "./render.js";
import type { Stage } from "./tui.js";

/**
 * Terminal-based approver used when the policy is "ask". Prints the pending
 * outward action and blocks for a decision:
 *
 *   y — approve this action
 *   n — deny this action
 *   a — approve, and auto-approve this tool for the rest of the session
 *
 * When a Stage is attached, its live animation region is suspended while the
 * prompt owns the terminal and resumed afterwards. Swap this for a web or
 * Slack approver by passing a different function into the orchestrator.
 */
export function createTerminalApprover(stage?: Stage): (req: ApprovalRequest) => Promise<boolean> {
  const sessionAllowed = new Set<string>();

  return async (req: ApprovalRequest): Promise<boolean> => {
    if (sessionAllowed.has(req.tool)) {
      const note = dim(`⚙ ${req.tool} auto-approved (session)\n`);
      if (stage) stage.print(note);
      else stdout.write(`\n${note}`);
      return true;
    }
    stage?.suspend();
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      stdout.write(`\n${yellow("⚠  Approval required")} — ${bold(req.tool)}\n`);
      stdout.write(`${dim(req.summary)}\n`);
      stdout.write(`   ${req.detail.replace(/\n/g, "\n   ")}\n`);
      const answer = (await rl.question(`   Approve? ${dim("[y]es / [n]o / [a]lways this tool")} `))
        .trim()
        .toLowerCase();
      if (answer === "a" || answer === "always") {
        sessionAllowed.add(req.tool);
        return true;
      }
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
      stage?.resume();
    }
  };
}

/** Single-shot approver retained for programmatic use. */
export const terminalApprover = createTerminalApprover();
