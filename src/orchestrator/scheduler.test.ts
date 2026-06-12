import { test } from "node:test";
import assert from "node:assert/strict";
import { msUntilDailyAt, parseDuration, Scheduler, type SchedulerClock } from "./scheduler.js";
import type { Schedule } from "../agent/config.js";

test("parseDuration handles s/m/h/d and rejects junk", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("15m"), 900_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  assert.throws(() => parseDuration("15"), /invalid duration/);
  assert.throws(() => parseDuration("2w"), /invalid duration/);
});

test("msUntilDailyAt picks today when still ahead, tomorrow otherwise", () => {
  const now = new Date();
  now.setHours(8, 0, 0, 0);
  assert.equal(msUntilDailyAt("09:30", now.getTime()), 90 * 60_000);
  assert.equal(msUntilDailyAt("08:00", now.getTime()), 24 * 3_600_000); // exactly now → tomorrow
  assert.equal(msUntilDailyAt("07:00", now.getTime()), 23 * 3_600_000);
});

/** Manual clock: timers fire only when advance() reaches them. */
function manualClock(): SchedulerClock & { advance(ms: number): void } {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

test("interval schedules fire repeatedly and stop cleanly", () => {
  const clock = manualClock();
  const fired: string[] = [];
  const schedules: Schedule[] = [{ every: "15m", input: "triage" }];
  const scheduler = new Scheduler(schedules, (s) => fired.push(s.input), clock);
  scheduler.start();

  clock.advance(14 * 60_000);
  assert.equal(fired.length, 0);
  clock.advance(60_000);
  assert.equal(fired.length, 1);
  clock.advance(30 * 60_000);
  assert.equal(fired.length, 3);

  scheduler.stop();
  clock.advance(60 * 60_000);
  assert.equal(fired.length, 3);
});

test("multiple schedules arm independently", () => {
  const clock = manualClock();
  const fired: string[] = [];
  const scheduler = new Scheduler(
    [
      { every: "10m", input: "a" },
      { every: "25m", input: "b" },
    ],
    (s) => fired.push(s.input),
    clock,
  );
  scheduler.start();
  clock.advance(30 * 60_000);
  assert.deepEqual(fired, ["a", "a", "b", "a"]);
  scheduler.stop();
});
