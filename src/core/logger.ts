/**
 * Tiny structured logger. No external dependency so the foundation stays
 * install-light; swap for pino/winston later behind the same interface.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m", // grey
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Returns a child logger that prefixes every line with these bound fields. */
  child(bindings: Record<string, unknown>): Logger;
}

class ConsoleLogger implements Logger {
  constructor(
    private readonly threshold: LogLevel,
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.threshold]) return;
    const merged = { ...this.bindings, ...fields };
    const scope = typeof merged.scope === "string" ? ` (${merged.scope})` : "";
    const extra = Object.entries(merged)
      .filter(([k]) => k !== "scope")
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    const ts = new Date().toISOString();
    const tag = `${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET}`;
    process.stderr.write(`${ts} ${tag}${scope} ${msg}${extra ? ` ${extra}` : ""}\n`);
  }

  debug(msg: string, fields?: Record<string, unknown>) { this.write("debug", msg, fields); }
  info(msg: string, fields?: Record<string, unknown>) { this.write("info", msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>) { this.write("warn", msg, fields); }
  error(msg: string, fields?: Record<string, unknown>) { this.write("error", msg, fields); }

  child(bindings: Record<string, unknown>): Logger {
    return new ConsoleLogger(this.threshold, { ...this.bindings, ...bindings });
  }
}

export function createLogger(level: LogLevel = "info"): Logger {
  return new ConsoleLogger(level);
}
