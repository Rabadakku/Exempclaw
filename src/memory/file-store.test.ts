import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMemoryStore } from "./file-store.js";

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), "exempclaw-"));
  return { dir, store: new FileMemoryStore(dir, "agent-1") };
}

test("addMemory persists and allMemories returns insertion order", async () => {
  const { store } = await freshStore();
  await store.addMemory({ text: "first", source: "self", tags: [] });
  await store.addMemory({ text: "second", source: "self", tags: [] });
  const all = await store.allMemories();
  assert.deepEqual(all.map((m) => m.text), ["first", "second"]);
  assert.ok(all[0]!.id);
  assert.ok(all[0]!.createdAt);
});

test("searchMemory ranks by term frequency with tag boost", async () => {
  const { store } = await freshStore();
  await store.addMemory({ text: "the quarterly report goes to finance", source: "email", tags: [] });
  await store.addMemory({ text: "report report report weekly", source: "slack", tags: [] });
  await store.addMemory({ text: "unrelated note", source: "self", tags: ["report"] });

  const hits = await store.searchMemory("report");
  assert.equal(hits.length, 3);
  // Three occurrences beat one; tag boost (2) beats single occurrence (1).
  assert.equal(hits[0]!.text, "report report report weekly");
  assert.equal(hits[1]!.text, "unrelated note");
});

test("searchMemory with no matches returns empty", async () => {
  const { store } = await freshStore();
  await store.addMemory({ text: "something", source: "self", tags: [] });
  assert.deepEqual(await store.searchMemory("zebra"), []);
});

test("removeMemory works by id and by prefix", async () => {
  const { store } = await freshStore();
  const a = await store.addMemory({ text: "keep", source: "self", tags: [] });
  const b = await store.addMemory({ text: "drop", source: "self", tags: [] });
  assert.equal(await store.removeMemory(b.id.slice(0, 8)), true);
  assert.equal(await store.removeMemory("nonexistent"), false);
  const all = await store.allMemories();
  assert.deepEqual(all.map((m) => m.id), [a.id]);
});

test("history round-trips and clears", async () => {
  const { store } = await freshStore();
  assert.deepEqual(await store.loadHistory(), []);
  await store.saveHistory([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ]);
  const loaded = await store.loadHistory();
  assert.equal(loaded.length, 2);
  await store.clearHistory();
  assert.deepEqual(await store.loadHistory(), []);
});

test("atomic writes leave no temp files behind", async () => {
  const { dir, store } = await freshStore();
  // concurrent writes exercise the write queue
  await Promise.all([
    store.addMemory({ text: "a", source: "self", tags: [] }),
    store.addMemory({ text: "b", source: "self", tags: [] }),
    store.addMemory({ text: "c", source: "self", tags: [] }),
  ]);
  assert.equal((await store.allMemories()).length, 3);
  const files = await readdir(join(dir, "agents", "agent-1"));
  assert.ok(files.every((f) => !f.endsWith(".tmp")), `temp files left: ${files.join(",")}`);
});
