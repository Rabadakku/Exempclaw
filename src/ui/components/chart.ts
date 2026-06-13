/**
 * Tiny dependency-free chart primitives for the terminal dashboard.
 * They return plain strings rendered inside ink <Text> with color applied
 * by the caller — so they stay pure and unit-testable.
 */

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * Renders a series as a unicode sparkline (one block char per value).
 * Heights scale to the series max; an all-zero series renders as a flat floor.
 */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max <= 0) return BLOCKS[0]!.repeat(values.length);
  return values
    .map((v) => {
      const idx = Math.max(0, Math.min(BLOCKS.length - 1, Math.round((v / max) * (BLOCKS.length - 1))));
      return BLOCKS[idx]!;
    })
    .join("");
}

/** A horizontal meter: filled blocks for `value/max`, light blocks for the rest. */
export function bar(value: number, max: number, width: number): string {
  if (width <= 0) return "";
  if (max <= 0) return "░".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Compact money: $1.2k, $42.17, $0.00. */
export function money(usd: number): string {
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`;
  return `$${usd.toFixed(2)}`;
}
