import { test } from "node:test";
import assert from "node:assert/strict";
import { sparkline, bar, money } from "./chart.js";

test("sparkline scales to the series max", () => {
  assert.equal(sparkline([0, 1, 2, 3, 4, 5, 6, 7]).length, 8);
  assert.equal(sparkline([]).length, 0);
  // all-zero series is a flat floor of the lowest block
  assert.equal(sparkline([0, 0, 0]), "▁▁▁");
  // the max value maps to the tallest block
  assert.ok(sparkline([1, 10]).endsWith("█"));
});

test("bar fills proportionally", () => {
  assert.equal(bar(5, 10, 10), "█████░░░░░");
  assert.equal(bar(0, 10, 4), "░░░░");
  assert.equal(bar(10, 10, 4), "████");
  assert.equal(bar(1, 0, 3), "░░░"); // zero max → empty meter, no divide-by-zero
});

test("money formats compactly", () => {
  assert.equal(money(0), "$0.00");
  assert.equal(money(42.17), "$42.17");
  assert.equal(money(1500), "$1.5k");
});
