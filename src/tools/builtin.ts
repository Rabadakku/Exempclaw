import { z } from "zod";
import { defineTool, type Tool } from "./tool.js";
import type { MemoryStore } from "../memory/store.js";

/**
 * Tools every agent gets regardless of connectors: durable memory and a clock.
 * These are inward (no approval needed) — they never touch the outside world.
 */
export function builtinTools(memory: MemoryStore): Tool[] {
  const remember = defineTool({
    name: "remember",
    description:
      "Store a durable fact, lesson, or piece of role context so future sessions retain it. Use for anything you'd want to know next time but that isn't already obvious from the conversation.",
    schema: z.object({
      text: z.string().describe("The fact or lesson to remember, stated concisely."),
      source: z.string().default("self").describe("Where this came from, e.g. email, slack, onboarding."),
      tags: z.array(z.string()).default([]).describe("Optional tags for later retrieval."),
    }),
    async execute(input) {
      const entry = await memory.addMemory({ text: input.text, source: input.source, tags: input.tags });
      return { content: `Stored memory ${entry.id}.` };
    },
  });

  const recall = defineTool({
    name: "recall",
    description: "Search your durable memory for relevant context by keyword.",
    schema: z.object({
      query: z.string().describe("What to search for."),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    async execute(input) {
      const hits = await memory.searchMemory(input.query, input.limit);
      if (hits.length === 0) return { content: "No matching memories." };
      return { content: hits.map((m) => `- (${m.source}) ${m.text}`).join("\n") };
    },
  });

  const now = defineTool({
    name: "current_time",
    description: "Get the current date and time in ISO-8601 (UTC).",
    schema: z.object({}),
    async execute() {
      return { content: new Date().toISOString() };
    },
  });

  return [remember, recall, now];
}
