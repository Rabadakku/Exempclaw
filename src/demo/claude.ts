import type Anthropic from "@anthropic-ai/sdk";
import type { ClaudeLike, ClaudeTurnParams } from "../llm/claude.js";
import type { AgentActivity } from "../tools/tool.js";

/**
 * The demo brain: a scripted ClaudeLike that drives the real agent loop —
 * tool calls, approval gates, memory writes, status animations — without an
 * API key. It pattern-matches the operator's message to a scenario and plays
 * it out turn by turn, reacting to denials. Token usage is fabricated and
 * the "claude-demo" model prices at $0.00.
 */

export interface DemoClaudeOptions {
  /** Pause before each turn, for a thinking feel. Default 700ms; tests use 0. */
  latencyMs?: number;
  /** Delay between streamed words. Default 16ms; tests use 0. */
  streamDelayMs?: number;
}

interface TurnContext {
  /** True if an outward action was denied earlier in this run. */
  denied: boolean;
}

interface ScenarioTurn {
  status?: { activity: AgentActivity; message: string };
  tools?: Array<{ name: string; input: Record<string, unknown> }>;
  text?: string | ((ctx: TurnContext) => string);
}

interface Scenario {
  match: RegExp;
  turns: ScenarioTurn[];
}

const TRIAGE: Scenario = {
  match: /initech|overnight|inbox|email|triage|morning|webhook|ana/i,
  turns: [
    {
      status: { activity: "searching", message: "combing the inbox and channels for Initech traffic" },
      tools: [
        { name: "email_search", input: { from: "initech", limit: 10 } },
        { name: "slack_read_channel", input: { channel: "#initech-account", limit: 20 } },
      ],
    },
    {
      status: { activity: "reading", message: "Ana's reply about the webhook retries" },
      tools: [{ name: "email_read_message", input: { uid: 4711 } }],
    },
    {
      text: "Ana confirmed the staging fix held through their overnight soak test — zero dropped events. She's asking for the production date and the volume-pricing one-pager ahead of the September renewal. Engineering proposed Thursday for prod in #initech-account, so I'll confirm \"this week, date locked today\" without promising the exact day in writing, and route the pricing ask to Marcus. Drafting the reply now.\n",
      status: { activity: "writing", message: "drafting a reply in the team's voice" },
      tools: [
        {
          name: "email_send",
          input: {
            to: ["ana.flores@initech.example"],
            subject: "Re: webhook retries dropping events",
            body:
              "Hi Ana,\n\nGreat news on the soak test — thanks for running it. The fix is slated for production this week; I'm confirming the exact date with engineering today and will follow up the moment it's locked.\n\nOn volume pricing: looping in Marcus Webb, who's preparing the one-pager with finance so you have it well before the September kickoff.\n\nBest,\nJordan (covering support for Alex)",
            inReplyTo: "<m-4711@initech.example>",
          },
        },
      ],
    },
    {
      tools: [
        { name: "email_mark_read", input: { uid: 4711 } },
        {
          name: "remember",
          input: {
            text: "Ana (Initech) confirmed the staging webhook fix on 2026-06-12; promised prod date follow-up this week and routed the volume-pricing one-pager to Marcus before the September renewal.",
            source: "email",
            tags: ["initech", "ana", "renewal"],
          },
        },
      ],
    },
    { status: { activity: "celebrating", message: "Initech thread handled end to end" } },
    {
      text: (ctx) =>
        ctx.denied
          ? "Understood — I didn't send the reply since it wasn't approved. The draft is in my notes: it confirms the soak-test result, promises the prod date this week, and routes the pricing one-pager to Marcus. Say the word (or re-run with approval) and it goes out. I did mark Ana's email read and noted the renewal context in memory."
          : "Done. One thing came in overnight that mattered: Ana confirmed the staging fix held, so I replied confirming production this week (exact date to follow — kept it out of writing per our convention) and routed her volume-pricing ask to Marcus for the September renewal. Her email is marked read and the renewal context is saved to memory. Nothing else in the inbox needed action.",
    },
  ],
};

const PRIORITIES: Scenario = {
  match: /priorit|week|today|plan|focus/i,
  turns: [
    {
      status: { activity: "reading", message: "reviewing the role briefing and open commitments" },
      tools: [{ name: "recall", input: { query: "renewal commitments deadlines process", limit: 10 } }],
    },
    {
      text:
        "Top of the list this week:\n\n" +
        "1. Initech — confirm the production date for the webhook fix and get Ana her volume-pricing one-pager moving (renewal kickoff is early September; Marcus owns the commercial side).\n" +
        "2. Monday's weekly support summary — due before noon, per the standing convention.\n" +
        "3. Keep an eye on billing disputes: anything over $500 goes to Sam, not us.\n\n" +
        "Want me to start the triage pass? Try: \"Anything from Initech overnight?\"",
    },
  ],
};

const IDENTITY: Scenario = {
  match: /who are you|are you (an? )?(ai|bot|human|robot)|yourself|real person/i,
  turns: [
    {
      text:
        "I'm Jordan — an AI assistant covering the Customer Support Lead role that Alex Rivera held, running on Exempclaw. I'm configured for transparent disclosure, so I'll always say so when asked (and in outward email too). Right now you're talking to the offline demo brain: a scripted stand-in, a fictional inbox, zero API calls.",
    },
  ],
};

const MEMORY: Scenario = {
  match: /remember|memory|know about/i,
  turns: [
    {
      status: { activity: "searching", message: "checking durable memory" },
      tools: [{ name: "recall", input: { query: "initech renewal process", limit: 10 } }],
    },
    {
      text:
        "Here's the shape of what I carry between sessions: Initech is the key account (Ana Flores, prefers email), their renewal kicks off in September with a volume-pricing ask, Marcus owns the commercial side, billing disputes over $500 escalate to Sam, and the weekly summary ships Mondays. Anything I learn while working — like today's soak-test confirmation — gets written back with the memory tool. You can browse it yourself with /memory.",
    },
  ],
};

const FALLBACK: Scenario = {
  match: /.*/,
  turns: [
    {
      status: { activity: "thinking", message: "getting oriented in the demo workspace" },
      tools: [{ name: "slack_read_channel", input: { channel: "#support", limit: 10 } }],
    },
    {
      text:
        "This is the offline demo: I'm a scripted brain attached to the real Exempclaw runtime — real tool loop, real approval gates, real memory, fictional Initech workspace, no API key. Things worth trying:\n\n" +
        '- "Anything from Initech overnight?" — a full triage: search, read, draft, and an outward email that asks for your approval\n' +
        '- "What are my priorities this week?"\n' +
        '- "Are you an AI?" — the disclosure policy at work\n' +
        "- /memory, /cost, /help — operator commands\n\n" +
        "When you connect a real key, the same agent runs on Claude instead of this script.",
    },
  ],
};

// Order matters: specific intents (identity, memory, priorities) win before
// the broad triage matcher, which also fires on bare "initech"/"inbox".
const SCENARIOS: Scenario[] = [IDENTITY, MEMORY, PRIORITIES, TRIAGE, FALLBACK];

export class DemoClaude implements ClaudeLike {
  private readonly latencyMs: number;
  private readonly streamDelayMs: number;
  private toolCounter = 0;

  constructor(opts: DemoClaudeOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 700;
    this.streamDelayMs = opts.streamDelayMs ?? 16;
  }

  async turn(params: ClaudeTurnParams): Promise<Anthropic.Message> {
    const { text: userText, assistantTurnsSince, denied } = analyzeMessages(params.messages);
    const scenario = SCENARIOS.find((s) => s.match.test(userText)) ?? FALLBACK;
    const turn = scenario.turns[Math.min(assistantTurnsSince, scenario.turns.length - 1)]!;

    await sleep(this.latencyMs, params.signal);
    throwIfAborted(params.signal);

    const content: Anthropic.ContentBlock[] = [];
    const text = typeof turn.text === "function" ? turn.text({ denied }) : turn.text;
    if (text) {
      await this.streamText(text, params.onText, params.signal);
      content.push({ type: "text", text, citations: null } as Anthropic.TextBlock);
    }
    if (turn.status) {
      content.push(this.toolUse("display_status", { activity: turn.status.activity, message: turn.status.message }));
    }
    for (const tool of turn.tools ?? []) {
      content.push(this.toolUse(tool.name, tool.input));
    }

    const hasTools = content.some((b) => b.type === "tool_use");
    return {
      id: `msg_demo_${++this.toolCounter}`,
      type: "message",
      role: "assistant",
      model: params.model ?? "claude-demo",
      content,
      stop_reason: hasTools ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: fabricateUsage(params.messages.length, assistantTurnsSince, text?.length ?? 0),
    } as unknown as Anthropic.Message;
  }

  async summarize(): Promise<string> {
    await sleep(this.latencyMs / 2);
    return "Demo summary: earlier turns covered Initech triage — Ana confirmed the staging webhook fix, a reply was drafted, and the September renewal context was recorded.";
  }

  private toolUse(name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock {
    return { type: "tool_use", id: `toolu_demo_${++this.toolCounter}`, name, input } as Anthropic.ToolUseBlock;
  }

  private async streamText(text: string, onText: ((delta: string) => void) | undefined, signal?: AbortSignal): Promise<void> {
    if (!onText) return;
    if (this.streamDelayMs <= 0) {
      onText(text);
      return;
    }
    for (const word of text.split(/(?<=\s)/)) {
      throwIfAborted(signal);
      onText(word);
      await sleep(this.streamDelayMs, signal);
    }
  }
}

/** Finds the operator's last real message, turns since it, and denial state. */
export function analyzeMessages(messages: Anthropic.MessageParam[]): {
  text: string;
  assistantTurnsSince: number;
  denied: boolean;
} {
  let text = "";
  let assistantTurnsSince = 0;
  let denied = false;
  let foundUser = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "assistant") {
      if (!foundUser) assistantTurnsSince++;
      continue;
    }
    if (typeof msg.content === "string") {
      text = msg.content;
      foundUser = true;
      break;
    }
    const toolResults = msg.content.filter((b) => b.type === "tool_result");
    if (toolResults.length > 0) {
      if (!foundUser) {
        for (const result of toolResults) {
          const body = typeof result.content === "string" ? result.content : JSON.stringify(result.content ?? "");
          if (result.is_error && /denied/i.test(body)) denied = true;
        }
      }
      continue;
    }
    const textBlock = msg.content.find((b) => b.type === "text");
    if (textBlock && textBlock.type === "text") {
      text = textBlock.text;
      foundUser = true;
      break;
    }
  }
  return { text, assistantTurnsSince, denied };
}

function fabricateUsage(messageCount: number, step: number, outputChars: number): Anthropic.Usage {
  const input = 900 + messageCount * 240;
  return {
    input_tokens: step === 0 ? input : Math.round(input * 0.12),
    output_tokens: Math.max(60, Math.round(outputChars / 3.5) + 90),
    cache_read_input_tokens: step === 0 ? 0 : Math.round(input * 0.88),
    cache_creation_input_tokens: step === 0 ? Math.round(input * 0.6) : 120,
  } as Anthropic.Usage;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("aborted");
}
