import type Anthropic from "@anthropic-ai/sdk";

/**
 * Token accounting shared by the agent runtime, run records, and the `costs`
 * CLI. Cache reads/writes are tracked separately because they bill at
 * different rates (~0.1x and 1.25x the input price respectively).
 */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Number of API turns these totals cover. */
  turns: number;
}

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };
}

/** Folds one API response's usage into a running total (returns a new object). */
export function addUsage(totals: UsageTotals, usage: Anthropic.Usage): UsageTotals {
  return {
    inputTokens: totals.inputTokens + usage.input_tokens,
    outputTokens: totals.outputTokens + usage.output_tokens,
    cacheReadTokens: totals.cacheReadTokens + (usage.cache_read_input_tokens ?? 0),
    cacheWriteTokens: totals.cacheWriteTokens + (usage.cache_creation_input_tokens ?? 0),
    turns: totals.turns + 1,
  };
}

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    turns: a.turns + b.turns,
  };
}

/** The total prompt size the model saw on the last turn (cached or not). */
export function contextTokens(usage: Anthropic.Usage): number {
  return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

/**
 * USD per million tokens. Matched by model-id prefix so dated variants
 * (claude-haiku-4-5-20251001) resolve to their family. Unknown models return
 * null cost — token counts are still tracked.
 */
const MODEL_PRICES: Array<{ prefix: string; inputPerMTok: number; outputPerMTok: number }> = [
  { prefix: "claude-fable-5", inputPerMTok: 10, outputPerMTok: 50 },
  { prefix: "claude-mythos-5", inputPerMTok: 10, outputPerMTok: 50 },
  { prefix: "claude-opus-4", inputPerMTok: 5, outputPerMTok: 25 },
  { prefix: "claude-sonnet-4", inputPerMTok: 3, outputPerMTok: 15 },
  { prefix: "claude-haiku-4", inputPerMTok: 1, outputPerMTok: 5 },
];

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export function estimateCostUsd(model: string, totals: UsageTotals): number | null {
  const price = MODEL_PRICES.find((p) => model.startsWith(p.prefix));
  if (!price) return null;
  const perTokIn = price.inputPerMTok / 1_000_000;
  const perTokOut = price.outputPerMTok / 1_000_000;
  return (
    totals.inputTokens * perTokIn +
    totals.outputTokens * perTokOut +
    totals.cacheReadTokens * perTokIn * CACHE_READ_MULTIPLIER +
    totals.cacheWriteTokens * perTokIn * CACHE_WRITE_MULTIPLIER
  );
}

export function formatUsd(value: number | null): string {
  if (value === null) return "n/a";
  return value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}
