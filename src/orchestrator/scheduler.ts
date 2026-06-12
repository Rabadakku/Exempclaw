import type { Schedule } from "../agent/config.js";

/**
 * Fires an agent's scheduled inputs. Two forms:
 *  - { every: "15m" }  — fixed interval from start
 *  - { dailyAt: "09:00" } — local wall-clock time, once a day
 *
 * The clock is injectable so tests can drive it deterministically.
 */

export interface SchedulerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): NodeJS.Timeout | number;
  clearTimeout(handle: NodeJS.Timeout | number): void;
}

const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export function parseDuration(spec: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(spec);
  if (!match) throw new Error(`invalid duration "${spec}" (use e.g. "30s", "15m", "2h", "1d")`);
  const value = Number(match[1]);
  const unit = match[2] as "s" | "m" | "h" | "d";
  return value * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
}

/** Milliseconds from `now` until the next local occurrence of HH:MM. */
export function msUntilDailyAt(timeSpec: string, now: number): number {
  const [hours, minutes] = timeSpec.split(":").map(Number) as [number, number];
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now;
}

export function msUntilNext(schedule: Schedule, now: number): number {
  if (schedule.every) return parseDuration(schedule.every);
  return msUntilDailyAt(schedule.dailyAt!, now);
}

/**
 * Runs one agent's schedules until stopped. Fires are delivered through
 * `onFire`; overlapping work is the dispatcher's problem (the orchestrator
 * serializes per-agent runs).
 */
export class Scheduler {
  private readonly handles: Array<NodeJS.Timeout | number> = [];
  private stopped = false;

  constructor(
    private readonly schedules: Schedule[],
    private readonly onFire: (schedule: Schedule) => void,
    private readonly clock: SchedulerClock = realClock,
  ) {}

  start(): void {
    for (const schedule of this.schedules) this.arm(schedule);
  }

  private arm(schedule: Schedule): void {
    if (this.stopped) return;
    const delay = msUntilNext(schedule, this.clock.now());
    const handle = this.clock.setTimeout(() => {
      if (this.stopped) return;
      this.onFire(schedule);
      this.arm(schedule); // chain the next occurrence
    }, delay);
    this.handles.push(handle);
  }

  stop(): void {
    this.stopped = true;
    for (const handle of this.handles) this.clock.clearTimeout(handle);
    this.handles.length = 0;
  }
}
