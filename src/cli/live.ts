import type { RunHooks } from "../agent/agent.js";
import type { AgentActivity } from "../tools/tool.js";
import { Stage, toolIcon, type AnimName } from "./tui.js";

/**
 * Wires an agent run's hooks to the animation stage:
 *
 *  - a thinking spinner while the model reasons (with elapsed time),
 *  - streamed text printed above the live region,
 *  - one animated row per in-flight tool call, settling ✓/✗ with duration,
 *  - the agent's own display_status signals as expressive activity rows,
 *  - "celebrating" plays a short burst and settles on its own.
 */

const STATUS_ANIMS: Record<AgentActivity, AnimName> = {
  thinking: "thinking",
  searching: "searching",
  reading: "reading",
  writing: "writing",
  sending: "sending",
  waiting: "waiting",
  celebrating: "celebrating",
  alert: "alert",
};

export interface LiveRun {
  hooks: RunHooks;
  /** Clear any leftover rows once the dispatch settles. */
  finish(opts?: { interrupted?: boolean }): void;
}

export function liveRunHooks(stage: Stage, speaker: string): LiveRun {
  let toolSeq = 0;
  const activeToolRows = new Map<string, string[]>(); // tool name → row-id stack
  let sawTextThisTurn = false;
  let celebrationTimer: NodeJS.Timeout | undefined;

  const dropThinkingRow = () => stage.removeRow("turn");

  const hooks: RunHooks = {
    onTurnStart(iteration) {
      sawTextThisTurn = false;
      stage.addRow("turn", {
        anim: "thinking",
        label: iteration === 1 ? `${speaker} is thinking` : `${speaker} is thinking it over`,
        color: "amber",
      });
    },

    onText(delta) {
      if (!sawTextThisTurn) {
        sawTextThisTurn = true;
        dropThinkingRow();
      }
      stage.write(delta);
    },

    onToolStart(name, input) {
      dropThinkingRow();
      const rowId = `tool:${name}:${++toolSeq}`;
      const stack = activeToolRows.get(name) ?? [];
      stack.push(rowId);
      activeToolRows.set(name, stack);
      stage.addRow(rowId, {
        anim: "tool",
        icon: toolIcon(name),
        label: name,
        hint: previewInput(input),
      });
    },

    onToolEnd(name, ok, detail) {
      const stack = activeToolRows.get(name);
      const rowId = stack?.shift();
      if (!rowId) return;
      stage.settleRow(rowId, {
        mark: ok ? "✓" : "✗",
        color: ok ? "green" : "red",
        ...(detail && !ok ? { suffix: `— ${detail}` } : {}),
      });
    },

    onStatus(activity, message) {
      if (celebrationTimer) {
        clearTimeout(celebrationTimer);
        celebrationTimer = undefined;
      }
      stage.addRow("status", {
        anim: STATUS_ANIMS[activity],
        icon: "≋",
        label: message,
        color: activity === "alert" ? "red" : "amber",
      });
      if (activity === "celebrating") {
        celebrationTimer = setTimeout(() => {
          stage.settleRow("status", { mark: "✦", color: "amber" });
        }, 1600);
        celebrationTimer.unref?.();
      }
    },
  };

  return {
    hooks,
    finish(opts = {}) {
      if (celebrationTimer) clearTimeout(celebrationTimer);
      if (opts.interrupted) {
        stage.print("");
      }
      stage.stopAll();
    },
  };
}

function previewInput(input: unknown): string {
  try {
    const json = JSON.stringify(input);
    if (!json || json === "{}") return "";
    return json.length > 60 ? `${json.slice(0, 60)}…` : json;
  } catch {
    return "";
  }
}
