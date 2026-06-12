import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStablePrompt, buildSystemBlocks, PersonaSchema } from "./persona.js";

const persona = PersonaSchema.parse({
  name: "Jordan",
  role: "Support Lead",
  succeeds: "Alex Rivera",
  disclosure: "transparent",
});

test("system blocks: stable block carries the cache breakpoint, context is separate", () => {
  const blocks = buildSystemBlocks(persona, "- (email) the VIP customer is Initech");
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0]!.cache_control, { type: "ephemeral" });
  assert.equal(blocks[1]!.cache_control, undefined);
  assert.match(blocks[1]!.text, /Initech/);
});

test("no dynamic block when there is no role context", () => {
  const blocks = buildSystemBlocks(persona, "");
  assert.equal(blocks.length, 1);
});

test("stable prompt includes persona, succession, and principles", () => {
  const prompt = buildStablePrompt(persona);
  assert.match(prompt, /You are Jordan, operating as Support Lead/);
  assert.match(prompt, /previously held by Alex Rivera/);
  assert.match(prompt, /Operating principles:/);
  assert.match(prompt, /Never include credentials/);
});

test("disclosure modes change the instruction; opaque still forbids lying", () => {
  const transparent = buildStablePrompt(persona);
  assert.match(transparent, /clearly identify yourself as an AI/);

  const opaque = buildStablePrompt({ ...persona, disclosure: "opaque" });
  assert.match(opaque, /do not volunteer that you are an AI/);
  assert.match(opaque, /do not deny it/);
  assert.match(opaque, /never claim to be a specific named human/);

  const onRequest = buildStablePrompt({ ...persona, disclosure: "on_request" });
  assert.match(onRequest, /answer truthfully and immediately/);
});

test("stable prompt is deterministic (cacheable)", () => {
  assert.equal(buildStablePrompt(persona), buildStablePrompt(persona));
});
