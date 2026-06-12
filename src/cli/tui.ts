import { performance } from "node:perf_hooks";

/**
 * Dependency-free terminal animation engine.
 *
 * The Stage owns a "live region" at the bottom of the terminal: a set of
 * animated rows (spinners, activity lines, progress bars) that are redrawn in
 * place while ordinary output scrolls above them. Rows settle into permanent
 * printed lines when their work finishes.
 *
 * Degrades gracefully: when stdout isn't a TTY (pipes, CI, tests) or
 * EXEMPCLAW_NO_ANIM is set, rows print once as plain lines and settle as
 * plain lines — no timers, no escape codes.
 */

const ESC = "\x1b[";
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_LINE = `${ESC}2K`;

const AMBER = `${ESC}38;5;214m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;

export type Paint = "amber" | "red" | "green" | "dim" | "plain";

function paint(color: Paint, text: string, enabled: boolean): string {
  if (!enabled || color === "plain") return text;
  const code = { amber: AMBER, red: RED, green: GREEN, dim: DIM }[color];
  return `${code}${text}${RESET}`;
}

/** A frame-based animation. All frames should render at the same width. */
export interface Anim {
  frames: string[];
  intervalMs: number;
  color?: Paint;
}

export function frameAt(anim: Anim, elapsedMs: number): string {
  const index = Math.floor(elapsedMs / anim.intervalMs) % anim.frames.length;
  return anim.frames[index]!;
}

/* ── frame library ─────────────────────────────────────────────────── */

export const ANIMS = {
  /** The mascot: a claw, pinching. */
  claw: { frames: ["(\\/)", "(\\|)", "(\\-)", "(\\|)"], intervalMs: 220, color: "amber" } as Anim,
  /** Classic braille spinner — model is reasoning. */
  thinking: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 90, color: "amber" } as Anim,
  /** A lens sweeping across slots. */
  searching: {
    frames: ["[●····]", "[·●···]", "[··●··]", "[···●·]", "[····●]", "[···●·]", "[··●··]", "[·●···]"],
    intervalMs: 110,
    color: "amber",
  } as Anim,
  /** Pages turning. */
  reading: { frames: ["◐", "◓", "◑", "◒"], intervalMs: 160, color: "amber" } as Anim,
  /** A cursor laying down ink. */
  writing: { frames: ["▍", "▌", "▋", "▊", "▋", "▌"], intervalMs: 130, color: "amber" } as Anim,
  /** An envelope leaving a dot trail. */
  sending: {
    frames: ["✉····", "·✉···", "··✉··", "···✉·", "····✉"],
    intervalMs: 140,
    color: "amber",
  } as Anim,
  /** Patient arc. */
  waiting: { frames: ["◜", "◠", "◝", "◞", "◡", "◟"], intervalMs: 140, color: "dim" } as Anim,
  /** Sparkle burst for wins. */
  celebrating: { frames: ["✦ · ˙", "˙ ✦ ·", "· ˙ ✦", "˙ · ✦", "✧ ˙ ·"], intervalMs: 120, color: "amber" } as Anim,
  /** Attention blink. */
  alert: { frames: ["▲", "△", "▲", "△"], intervalMs: 260, color: "red" } as Anim,
  /** Generic tool gear-tick. */
  tool: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 90, color: "dim" } as Anim,
} satisfies Record<string, Anim>;

export type AnimName = keyof typeof ANIMS;

/** Static icons that prefix tool rows, keyed by tool-name prefix. */
const TOOL_ICONS: Array<[prefix: string, icon: string]> = [
  ["email_", "✉"],
  ["slack_", "#"],
  ["github_", "⎇"],
  ["notion_", "▤"],
  ["remember", "◆"],
  ["recall", "◇"],
  ["display_status", "≋"],
  ["current_time", "◷"],
];

export function toolIcon(name: string): string {
  for (const [prefix, icon] of TOOL_ICONS) {
    if (name.startsWith(prefix)) return icon;
  }
  return "⚙";
}

/* ── stage ─────────────────────────────────────────────────────────── */

interface Row {
  id: string;
  icon?: string;
  label: string;
  anim: Anim;
  color: Paint;
  startedAt: number;
  /** Extra right-aligned hint, e.g. a progress fraction. */
  hint?: string;
}

export interface StageWriter {
  write(text: string): unknown;
}

export interface StageOptions {
  out?: StageWriter;
  /** Force TTY behavior on/off; defaults to stdout.isTTY && !EXEMPCLAW_NO_ANIM. */
  tty?: boolean;
  intervalMs?: number;
  now?: () => number;
}

export class Stage {
  private readonly out: StageWriter;
  private readonly tty: boolean;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private rows: Row[] = [];
  private renderedLines = 0;
  private timer?: NodeJS.Timeout;
  private suspended = false;
  private cursorHidden = false;

  constructor(opts: StageOptions = {}) {
    this.out = opts.out ?? process.stdout;
    this.tty =
      opts.tty ??
      (process.stdout.isTTY === true && !process.env.EXEMPCLAW_NO_ANIM && !process.env.NO_COLOR);
    this.intervalMs = opts.intervalMs ?? 80;
    this.now = opts.now ?? (() => performance.now());
  }

  get isAnimated(): boolean {
    return this.tty;
  }

  /** Adds (or replaces) an animated row. */
  addRow(id: string, spec: { label: string; anim?: AnimName | Anim; icon?: string; color?: Paint; hint?: string }): void {
    const anim = typeof spec.anim === "object" ? spec.anim : ANIMS[spec.anim ?? "tool"];
    const row: Row = {
      id,
      icon: spec.icon,
      label: spec.label,
      anim,
      color: spec.color ?? anim.color ?? "plain",
      startedAt: this.now(),
      hint: spec.hint,
    };
    const existing = this.rows.findIndex((r) => r.id === id);
    if (existing >= 0) {
      row.startedAt = this.rows[existing]!.startedAt;
      this.rows[existing] = row;
    } else {
      this.rows.push(row);
      if (!this.tty) {
        this.out.write(`${row.icon ? `${row.icon} ` : ""}${row.label}…\n`);
      }
    }
    this.wake();
  }

  updateRow(id: string, patch: { label?: string; hint?: string }): void {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    if (patch.label !== undefined) row.label = patch.label;
    if (patch.hint !== undefined) row.hint = patch.hint;
    this.wake();
  }

  /** Removes a row and prints its permanent settled line. */
  settleRow(id: string, opts: { mark?: string; color?: Paint; label?: string; suffix?: string } = {}): void {
    const row = this.takeRow(id);
    if (!row) return;
    const mark = opts.mark ?? "✓";
    const color = opts.color ?? "green";
    const label = opts.label ?? row.label;
    const elapsed = this.elapsedText(row);
    const line = `${paint(color, mark, this.tty)} ${row.icon ? `${row.icon} ` : ""}${label}${opts.suffix ? ` ${opts.suffix}` : ""}${elapsed}`;
    this.print(`${line}\n`);
  }

  /** Removes a row without printing anything. */
  removeRow(id: string): void {
    this.takeRow(id);
  }

  /** Writes ordinary output above the live region. */
  print(text: string): void {
    if (!this.tty) {
      this.out.write(text);
      return;
    }
    this.erase();
    this.out.write(text);
    this.render();
  }

  /** Streaming-friendly raw write (no trailing newline added). */
  write(text: string): void {
    this.print(text);
  }

  /** Temporarily clears the live region (e.g. while a prompt owns the line). */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    if (this.tty) {
      this.erase();
      this.stopTimer();
      this.setCursor(true);
    }
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.wake();
  }

  /** Clears everything without settling — end of a run or shutdown. */
  stopAll(): void {
    this.rows = [];
    if (this.tty) this.erase();
    this.stopTimer();
    this.setCursor(true);
  }

  /* ── internals ── */

  private takeRow(id: string): Row | undefined {
    const index = this.rows.findIndex((r) => r.id === id);
    if (index < 0) return undefined;
    const [row] = this.rows.splice(index, 1);
    if (this.tty) {
      this.erase();
      this.render();
    }
    if (this.rows.length === 0) this.stopTimer();
    return row;
  }

  private elapsedText(row: Row): string {
    const seconds = (this.now() - row.startedAt) / 1000;
    if (seconds < 0.05) return "";
    return paint("dim", ` · ${seconds.toFixed(1)}s`, this.tty);
  }

  private wake(): void {
    if (!this.tty || this.suspended) return;
    this.setCursor(false);
    this.render();
    if (!this.timer && this.rows.length > 0) {
      this.timer = setInterval(() => this.render(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private erase(): void {
    if (this.renderedLines === 0) return;
    let seq = "";
    for (let i = 0; i < this.renderedLines; i++) {
      seq += `${ESC}1A${CLEAR_LINE}`;
    }
    seq += "\r";
    this.out.write(seq);
    this.renderedLines = 0;
  }

  private render(): void {
    if (!this.tty || this.suspended) return;
    this.erase();
    if (this.rows.length === 0) {
      this.setCursor(true);
      return;
    }
    let block = "";
    for (const row of this.rows) {
      const frame = paint(row.color, frameAt(row.anim, this.now() - row.startedAt), this.tty);
      const icon = row.icon ? `${row.icon} ` : "";
      const hint = row.hint ? paint("dim", ` ${row.hint}`, this.tty) : "";
      block += `${frame} ${icon}${row.label}${hint}${this.elapsedText(row)}\n`;
    }
    this.out.write(block);
    this.renderedLines = this.rows.length;
  }

  private setCursor(visible: boolean): void {
    if (!this.tty) return;
    if (visible && this.cursorHidden) {
      this.out.write(SHOW_CURSOR);
      this.cursorHidden = false;
    } else if (!visible && !this.cursorHidden) {
      this.out.write(HIDE_CURSOR);
      this.cursorHidden = true;
      ensureCursorRestoredOnExit();
    }
  }
}

let exitHookInstalled = false;
function ensureCursorRestoredOnExit(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    if (process.stdout.isTTY) process.stdout.write(SHOW_CURSOR);
  });
}

/* ── banner ────────────────────────────────────────────────────────── */

/**
 * Plays the animated wordmark: the claw pinches while the letters sweep in.
 * Resolves in ~700ms; prints a single static line on non-TTY terminals.
 */
export async function playBanner(subtitle: string, opts: StageOptions = {}): Promise<void> {
  const out = opts.out ?? process.stdout;
  const tty =
    opts.tty ?? (process.stdout.isTTY === true && !process.env.EXEMPCLAW_NO_ANIM && !process.env.NO_COLOR);
  const word = "E X E M P C L A W";

  if (!tty) {
    out.write(`(\\/) ${word} — ${subtitle}\n`);
    return;
  }

  const claw = ANIMS.claw.frames;
  const steps = 10;
  out.write(HIDE_CURSOR);
  for (let i = 0; i <= steps; i++) {
    const visible = Math.round((word.length * i) / steps);
    const frame = claw[i % claw.length]!;
    const text = word.slice(0, visible);
    const ghost = " ".repeat(word.length - visible);
    out.write(`\r${CLEAR_LINE}${AMBER}${frame}${RESET} ${AMBER}${text}${RESET}${ghost}`);
    await sleepMs(55);
  }
  out.write(`\r${CLEAR_LINE}${AMBER}(\\/)${RESET} ${AMBER}${word}${RESET}\n`);
  out.write(`${DIM}     ${subtitle}${RESET}\n`);
  out.write(SHOW_CURSOR);
}

/** Renders a fixed-width progress bar like ▰▰▰▱▱. */
export function progressBar(done: number, total: number, width = 14): string {
  if (total <= 0) return "▱".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/** One-shot flash: a few quick frames, then a permanent line (TTY only). */
export async function flashLine(text: string, opts: StageOptions = {}): Promise<void> {
  const out = opts.out ?? process.stdout;
  const tty =
    opts.tty ?? (process.stdout.isTTY === true && !process.env.EXEMPCLAW_NO_ANIM && !process.env.NO_COLOR);
  if (!tty) {
    out.write(`${text}\n`);
    return;
  }
  for (const frame of ["⚡", "✦", "⚡"]) {
    out.write(`\r${CLEAR_LINE}${AMBER}${frame}${RESET} ${text}`);
    await sleepMs(70);
  }
  out.write(`\r${CLEAR_LINE}${AMBER}⚡${RESET} ${text}\n`);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
