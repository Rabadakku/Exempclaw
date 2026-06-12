import { formatUsd, type UsageTotals } from "../core/usage.js";

/** Minimal ANSI helpers for the CLI. Colors disabled when not a TTY. */

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function wrap(code: string): (text: string) => string {
  return (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
}

export const dim = wrap("2");
export const bold = wrap("1");
export const green = wrap("32");
export const red = wrap("31");
export const yellow = wrap("33");
export const cyan = wrap("36");

export const ok = (text: string) => `${green("✓")} ${text}`;
export const fail = (text: string) => `${red("✗")} ${text}`;
export const warn = (text: string) => `${yellow("!")} ${text}`;

/** Renders rows as a left-aligned table with two-space gutters. */
export function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, stripAnsi(cell).length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => cell + " ".repeat((widths[i] ?? 0) - stripAnsi(cell).length))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** One-line run summary shown after chat/run completes. */
export function usageLine(usage: UsageTotals, costUsd: number | null, iterations: number): string {
  const tokens = `${formatTokens(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)} in / ${formatTokens(usage.outputTokens)} out`;
  const cache = usage.cacheReadTokens > 0 ? ` · ${formatTokens(usage.cacheReadTokens)} cached` : "";
  return dim(`↳ ${iterations} turn${iterations === 1 ? "" : "s"} · ${tokens}${cache} · ${formatUsd(costUsd)}`);
}
