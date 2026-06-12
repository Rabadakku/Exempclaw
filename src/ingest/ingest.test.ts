import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { chunkFiles, collectFiles, ingestArchive, type IngestClaude } from "./ingest.js";
import { InMemoryStore, quietLogger } from "../testing/factories.js";
import { PersonaSchema } from "../agent/persona.js";

const persona = PersonaSchema.parse({ name: "Jordan", role: "Support Lead", succeeds: "Alex" });

async function makeArchive(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "exempclaw-archive-"));
  await writeFile(join(dir, "notes.md"), "# Handoff\nThe VIP customer is Initech.\n");
  await writeFile(join(dir, "thread.eml"), "From: ana@client.com\nSubject: rollout\n\nNeeds reply by Friday.\n");
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "sub", "process.txt"), "Weekly report goes out Mondays.\n");
  await writeFile(join(dir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(dir, "empty.txt"), "   \n");
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, ".git", "config.txt"), "should not be read");
  return dir;
}

test("collectFiles picks text files, skips binaries/empty/hidden", async () => {
  const dir = await makeArchive();
  const { files, skipped } = await collectFiles(dir, 512 * 1024);
  assert.deepEqual(files.map((f) => f.path).sort(), ["notes.md", "sub/process.txt", "thread.eml"]);
  assert.ok(skipped.some((s) => s.includes("image.png")));
  assert.ok(skipped.some((s) => s.includes("empty.txt")));
  assert.ok(!files.some((f) => f.path.includes(".git")));
});

test("collectFiles skips oversized files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exempclaw-archive-"));
  await writeFile(join(dir, "big.txt"), "x".repeat(2000));
  await writeFile(join(dir, "small.txt"), "ok");
  const { files, skipped } = await collectFiles(dir, 1000);
  assert.deepEqual(files.map((f) => f.path), ["small.txt"]);
  assert.ok(skipped[0]!.includes("too large"));
});

test("chunkFiles packs small files together and splits oversized ones", () => {
  const small = [
    { path: "a.txt", text: "aaa" },
    { path: "b.txt", text: "bbb" },
  ];
  const packed = chunkFiles(small, 1000);
  assert.equal(packed.length, 1);
  assert.deepEqual(packed[0]!.files, ["a.txt", "b.txt"]);
  assert.match(packed[0]!.text, /===== FILE: a.txt =====/);

  const big = [{ path: "big.txt", text: "para one\n\n".repeat(40) }]; // 400 chars
  const split = chunkFiles(big, 150);
  assert.ok(split.length >= 2);
  assert.match(split[0]!.text, /part 1\//);
});

test("ingestArchive distills chunks into memories plus a briefing", async () => {
  const dir = await makeArchive();
  const memory = new InMemoryStore();
  const prompts: string[] = [];
  const claude: IngestClaude = {
    async extract({ prompt }) {
      prompts.push(prompt as string);
      return {
        value: {
          memories: [
            { text: "VIP customer is Initech", tags: ["Initech", "customer"] },
            { text: "Weekly report goes out Mondays", tags: ["process"] },
          ],
        },
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as Anthropic.Usage,
      } as never;
    },
    async summarize() {
      return "BRIEFING: prioritize Initech.";
    },
  };

  const result = await ingestArchive({ dir, persona, memory, claude, log: quietLogger() });
  assert.equal(result.files, 3);
  assert.equal(result.chunks, 1);
  assert.equal(result.memoriesAdded, 3); // 2 distilled + briefing
  assert.equal(result.briefing, "BRIEFING: prioritize Initech.");
  assert.equal(result.usage.turns, 1);

  const stored = memory.memories;
  assert.equal(stored.length, 3);
  assert.ok(stored.every((m) => m.source === "onboarding"));
  assert.deepEqual(stored[0]!.tags, ["initech", "customer"]); // lowercased
  assert.deepEqual(stored[2]!.tags, ["briefing"]);
  // the chunk fed to Claude contains the actual file content
  assert.match(prompts[0]!, /Initech/);
  assert.match(prompts[0]!, /Mondays/);
});

test("collectFiles parses .eml into clean header + body text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exempclaw-eml-"));
  await writeFile(
    join(dir, "msg.eml"),
    [
      "From: Ana Flores <ana@client.com>",
      "To: alex@acme.com",
      "Subject: renewal timing",
      "Date: Mon, 02 Jun 2026 14:11:09 -0500",
      "Content-Type: text/plain",
      "",
      "Finance starts the renewal conversation in September.",
    ].join("\r\n"),
  );
  const { files } = await collectFiles(dir, 512 * 1024);
  assert.equal(files.length, 1);
  const text = files[0]!.text;
  assert.match(text, /From: .*Ana Flores/);
  assert.match(text, /Subject: renewal timing/);
  assert.match(text, /renewal conversation in September/);
  assert.ok(!text.includes("Content-Type"), "MIME headers are stripped");
});

test("collectFiles splits .mbox archives into parsed messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exempclaw-mbox-"));
  const message = (from: string, subject: string, body: string) =>
    [`From ${from} Mon Jun  2 14:11:09 2026`, `From: ${from}`, `Subject: ${subject}`, "", body, ""].join("\n");
  await writeFile(
    join(dir, "inbox.mbox"),
    message("ana@client.com", "first", "Body of the first message.") +
      message("sam@acme.com", "second", "Body of the second message."),
  );
  const { files } = await collectFiles(dir, 512 * 1024);
  assert.equal(files.length, 1);
  const text = files[0]!.text;
  assert.match(text, /Subject: first/);
  assert.match(text, /Body of the first message/);
  assert.match(text, /Subject: second/);
  assert.match(text, /Body of the second message/);
  assert.match(text, /----/); // message separator
});

test("ingestArchive emits structured progress events", async () => {
  const dir = await makeArchive();
  const memory = new InMemoryStore();
  const events: string[] = [];
  const claude: IngestClaude = {
    async extract() {
      return {
        value: { memories: [{ text: "fact", tags: [] }] },
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as Anthropic.Usage,
      } as never;
    },
    async summarize() {
      return "B";
    },
  };
  await ingestArchive({
    dir,
    persona,
    memory,
    claude,
    log: quietLogger(),
    onProgress: (e) => events.push(e.phase),
  });
  assert.deepEqual(events, ["scanned", "chunk", "briefing"]);
});

test("ingestArchive on an empty dir is a clean no-op", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exempclaw-empty-"));
  const memory = new InMemoryStore();
  const claude: IngestClaude = {
    async extract() {
      throw new Error("should not be called");
    },
    async summarize() {
      throw new Error("should not be called");
    },
  };
  const result = await ingestArchive({ dir, persona, memory, claude, log: quietLogger() });
  assert.equal(result.files, 0);
  assert.equal(result.memoriesAdded, 0);
});

test("ingestArchive caps the number of chunks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exempclaw-cap-"));
  for (let i = 0; i < 5; i++) await writeFile(join(dir, `f${i}.txt`), "z".repeat(500));
  const memory = new InMemoryStore();
  let calls = 0;
  const claude: IngestClaude = {
    async extract() {
      calls++;
      return {
        value: { memories: [] },
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as Anthropic.Usage,
      } as never;
    },
    async summarize() {
      return "S";
    },
  };
  const result = await ingestArchive({ dir, persona, memory, claude, log: quietLogger(), chunkChars: 600, maxChunks: 2 });
  assert.equal(calls, 2);
  assert.equal(result.chunks, 2);
});
