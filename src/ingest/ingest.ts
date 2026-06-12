import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { z } from "zod";
import { simpleParser, type ParsedMail } from "mailparser";
import type { ClaudeClient } from "../llm/claude.js";
import type { Logger } from "../core/logger.js";
import { addUsage, emptyUsage, type UsageTotals } from "../core/usage.js";
import type { MemoryStore } from "../memory/store.js";
import type { Persona } from "../agent/persona.js";

/**
 * The onboarding pass: read a departed employee's exported artifacts (mail
 * exports, docs, notes, tickets — anything text), distill them into durable
 * role memories, and seed the agent's MemoryStore. Run once per agent with
 * `exempclaw ingest <agent.json> <dir>`.
 */

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".eml",
  ".mbox",
  ".json",
  ".csv",
  ".tsv",
  ".log",
  ".html",
  ".htm",
  ".xml",
  ".yaml",
  ".yml",
]);

/** Structured progress events for the CLI's animated rendering. */
export type IngestProgress =
  | { phase: "scanned"; files: number; skipped: number }
  | { phase: "chunk"; index: number; total: number; files: string[] }
  | { phase: "briefing" };

/** The slice of ClaudeClient ingestion needs (substitutable in tests). */
export type IngestClaude = Pick<ClaudeClient, "extract" | "summarize">;

export interface IngestOptions {
  dir: string;
  persona: Persona;
  memory: MemoryStore;
  claude: IngestClaude;
  model?: string;
  log: Logger;
  /** Skip files larger than this. Default 512 KiB. */
  maxFileBytes?: number;
  /** Target characters per distillation call. Default 24000. */
  chunkChars?: number;
  /** Upper bound on distillation calls, to bound cost. Default 60. */
  maxChunks?: number;
  /** Also synthesize a role briefing from the distilled memories. Default true. */
  briefing?: boolean;
  onProgress?: (event: IngestProgress) => void;
  signal?: AbortSignal;
}

export interface IngestResult {
  files: number;
  chunks: number;
  memoriesAdded: number;
  skippedFiles: string[];
  briefing?: string;
  usage: UsageTotals;
}

const DistilledSchema = z.object({
  memories: z.array(
    z.object({
      text: z.string().describe("One durable, self-contained fact."),
      tags: z.array(z.string()).default([]),
    }),
  ),
});

interface SourceFile {
  path: string;
  text: string;
}

interface Chunk {
  text: string;
  files: string[];
}

export async function ingestArchive(opts: IngestOptions): Promise<IngestResult> {
  const maxFileBytes = opts.maxFileBytes ?? 512 * 1024;
  const chunkChars = opts.chunkChars ?? 24_000;
  const maxChunks = opts.maxChunks ?? 60;
  const progress = opts.onProgress ?? (() => undefined);

  const { files, skipped } = await collectFiles(opts.dir, maxFileBytes);
  if (files.length === 0) {
    progress({ phase: "scanned", files: 0, skipped: skipped.length });
    return { files: 0, chunks: 0, memoriesAdded: 0, skippedFiles: skipped, usage: emptyUsage() };
  }
  progress({ phase: "scanned", files: files.length, skipped: skipped.length });

  let chunks = chunkFiles(files, chunkChars);
  if (chunks.length > maxChunks) {
    opts.log.warn("archive larger than chunk budget; ingesting the first chunks only", {
      chunks: chunks.length,
      maxChunks,
    });
    chunks = chunks.slice(0, maxChunks);
  }

  let usage = emptyUsage();
  let memoriesAdded = 0;
  const distilledTexts: string[] = [];

  for (const [index, chunk] of chunks.entries()) {
    if (opts.signal?.aborted) break;
    progress({ phase: "chunk", index: index + 1, total: chunks.length, files: chunk.files });
    const { value, usage: turnUsage } = await opts.claude.extract({
      model: opts.model,
      schema: DistilledSchema,
      system: distillationSystemPrompt(opts.persona),
      prompt: chunk.text,
      effort: "medium",
      signal: opts.signal,
    });
    usage = addUsage(usage, turnUsage);
    for (const memory of value.memories) {
      await opts.memory.addMemory({
        text: memory.text,
        source: "onboarding",
        tags: [...new Set(memory.tags.map((t) => t.toLowerCase()))],
      });
      distilledTexts.push(memory.text);
      memoriesAdded++;
    }
  }

  let briefing: string | undefined;
  if ((opts.briefing ?? true) && distilledTexts.length > 0 && !opts.signal?.aborted) {
    progress({ phase: "briefing" });
    const summary = await opts.claude.summarize(distilledTexts.join("\n- "), {
      model: opts.model,
      instruction: briefingInstruction(opts.persona),
      signal: opts.signal,
    });
    await opts.memory.addMemory({ text: summary, source: "onboarding", tags: ["briefing"] });
    memoriesAdded++;
    briefing = summary;
  }

  return { files: files.length, chunks: chunks.length, memoriesAdded, skippedFiles: skipped, briefing, usage };
}

function distillationSystemPrompt(persona: Persona): string {
  return [
    `You are preparing role context for ${persona.name}, who is taking over as ${persona.role}` +
      (persona.succeeds ? ` from ${persona.succeeds}.` : "."),
    "You will be given raw work artifacts (emails, docs, notes, tickets). Extract durable, forward-useful facts:",
    "- people: who they are, their role, and how they relate to this role",
    "- in-flight work, open commitments, and deadlines (with dates when stated)",
    "- recurring processes, conventions, and where things live",
    "- key decisions and their rationale",
    "Each memory must be one self-contained sentence or two, understandable without the source document.",
    "Skip pleasantries, duplicates, trivia, and anything stale. NEVER extract passwords, API keys, tokens, or other secrets — omit them entirely.",
    "Tag each memory with short lowercase topics (e.g. a person's name, a project, \"process\", \"deadline\").",
    "If a document contains nothing durable, return an empty list.",
  ].join("\n");
}

function briefingInstruction(persona: Persona): string {
  return (
    `Write a role briefing for ${persona.name}, the incoming ${persona.role}` +
    (persona.succeeds ? ` succeeding ${persona.succeeds}` : "") +
    ". From the distilled notes below, produce a compact briefing covering: top priorities right now, " +
    "key people and what they need, in-flight commitments with dates, and how this role usually operates. " +
    "Dense prose, no fluff."
  );
}

/** Recursively collects readable text files, skipping junk and oversized files. */
export async function collectFiles(
  dir: string,
  maxFileBytes: number,
): Promise<{ files: SourceFile[]; skipped: string[] }> {
  const files: SourceFile[] = [];
  const skipped: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(dir, full);
      if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        skipped.push(rel);
        continue;
      }
      const info = await stat(full);
      if (info.size > maxFileBytes) {
        skipped.push(`${rel} (too large)`);
        continue;
      }
      const raw = await readFile(full, "utf8");
      const text = await normalizeText(raw, extname(entry.name).toLowerCase());
      if (text.trim().length === 0) {
        skipped.push(`${rel} (empty)`);
        continue;
      }
      files.push({ path: rel, text });
    }
  }

  await walk(dir);
  return { files, skipped };
}

async function normalizeText(raw: string, ext: string): Promise<string> {
  let text = raw;
  if (ext === ".html" || ext === ".htm") {
    text = text
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ");
  } else if (ext === ".eml") {
    text = await parseEmlForIngest(raw);
  } else if (ext === ".mbox") {
    text = await parseMboxForIngest(raw);
  }
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/** Parses one RFC-822 message into clean header + body text for distillation. */
async function parseEmlForIngest(raw: string): Promise<string> {
  try {
    const mail = await simpleParser(raw);
    return renderMailForIngest(mail);
  } catch {
    return raw; // fall back to the raw source rather than dropping the file
  }
}

/**
 * Splits a classic mbox (messages separated by "From " lines) and parses each
 * message. Caps the number of messages so a giant archive can't explode a
 * single file into unbounded text.
 */
async function parseMboxForIngest(raw: string, maxMessages = 200): Promise<string> {
  const parts = raw.split(/^From .*$/m).filter((p) => p.trim().length > 0);
  if (parts.length === 0) return raw;
  const rendered: string[] = [];
  for (const part of parts.slice(0, maxMessages)) {
    try {
      const mail = await simpleParser(part.trim());
      rendered.push(renderMailForIngest(mail));
    } catch {
      // skip unparseable fragments
    }
  }
  if (parts.length > maxMessages) {
    rendered.push(`[…${parts.length - maxMessages} more messages truncated…]`);
  }
  return rendered.join("\n\n----\n\n");
}

function renderMailForIngest(mail: ParsedMail): string {
  const to = Array.isArray(mail.to) ? mail.to.map((t) => t.text).join(", ") : mail.to?.text;
  const body = (mail.text ?? "").trim();
  return [
    `From: ${mail.from?.text ?? "?"}`,
    to ? `To: ${to}` : "",
    mail.date ? `Date: ${mail.date.toISOString()}` : "",
    `Subject: ${mail.subject ?? "(no subject)"}`,
    "",
    body,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Greedily packs files into chunks; oversized files split on paragraphs. */
export function chunkFiles(files: SourceFile[], chunkChars: number): Chunk[] {
  const chunks: Chunk[] = [];
  let buffer = "";
  let bufferFiles: string[] = [];

  const flush = () => {
    if (buffer.trim()) chunks.push({ text: buffer, files: bufferFiles });
    buffer = "";
    bufferFiles = [];
  };

  for (const file of files) {
    const pieces = file.text.length > chunkChars ? splitText(file.text, chunkChars) : [file.text];
    for (const [i, piece] of pieces.entries()) {
      const label = pieces.length > 1 ? `${file.path} (part ${i + 1}/${pieces.length})` : file.path;
      const section = `===== FILE: ${label} =====\n${piece}\n`;
      if (buffer.length > 0 && buffer.length + section.length > chunkChars) flush();
      buffer += section;
      if (!bufferFiles.includes(file.path)) bufferFiles.push(file.path);
    }
  }
  flush();
  return chunks;
}

function splitText(text: string, max: number): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    // Prefer a paragraph boundary in the back half of the window.
    let cut = remaining.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = max;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.trim()) parts.push(remaining);
  return parts;
}
