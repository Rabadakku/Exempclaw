import { test } from "node:test";
import assert from "node:assert/strict";
import { addUsage, addTotals, contextTokens, emptyUsage, estimateCostUsd, formatUsd } from "./usage.js";
import type Anthropic from "@anthropic-ai/sdk";

const usage = (input: number, output: number, read = 0, write = 0): Anthropic.Usage =>
  ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
  }) as Anthropic.Usage;

test("addUsage accumulates and counts turns, tolerating null cache fields", () => {
  let totals = emptyUsage();
  totals = addUsage(totals, usage(100, 50, 10, 5));
  totals = addUsage(totals, {
    input_tokens: 1,
    output_tokens: 2,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
  } as Anthropic.Usage);
  assert.deepEqual(totals, {
    inputTokens: 101,
    outputTokens: 52,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    turns: 2,
  });
});

test("addTotals merges two totals", () => {
  const a = addUsage(emptyUsage(), usage(10, 20));
  const b = addUsage(emptyUsage(), usage(1, 2, 3, 4));
  assert.deepEqual(addTotals(a, b), {
    inputTokens: 11,
    outputTokens: 22,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    turns: 2,
  });
});

test("contextTokens is the full prompt size including cache", () => {
  assert.equal(contextTokens(usage(100, 50, 1000, 200)), 1300);
});

test("estimateCostUsd prices known model families by prefix", () => {
  const totals = addUsage(emptyUsage(), usage(1_000_000, 1_000_000));
  assert.equal(estimateCostUsd("claude-opus-4-8", totals), 5 + 25);
  // dated variants resolve too
  assert.equal(estimateCostUsd("claude-haiku-4-5-20251001", totals), 1 + 5);
});

test("estimateCostUsd prices cache reads/writes at their multipliers", () => {
  const totals = addUsage(emptyUsage(), usage(0, 0, 1_000_000, 1_000_000));
  // opus input $5/MTok → reads 0.1x = $0.50, writes 1.25x = $6.25
  assert.equal(estimateCostUsd("claude-opus-4-8", totals), 0.5 + 6.25);
});

test("estimateCostUsd returns null for unknown models", () => {
  assert.equal(estimateCostUsd("gpt-from-the-future", emptyUsage()), null);
});

test("formatUsd shows small values with more precision", () => {
  assert.equal(formatUsd(null), "n/a");
  assert.equal(formatUsd(0.0042), "$0.0042");
  assert.equal(formatUsd(1.5), "$1.50");
});
