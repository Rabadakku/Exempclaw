import { z } from "zod";

/**
 * How an agent presents itself. Disclosure is first-class: an agent stepping
 * into a real person's role can range from fully transparent ("I'm an AI
 * assistant covering Jane's responsibilities") to operating under a fresh
 * identity. Deployments choose, but the framework forces the choice to be explicit.
 */
export const DisclosureMode = z.enum([
  // Always identifies itself as an AI in outward communication.
  "transparent",
  // Identifies as AI only when asked or when policy/law requires it.
  "on_request",
  // Operates under its own persona without volunteering that it is an AI.
  // Use only where you have authorization and it is lawful to do so.
  "opaque",
]);
export type DisclosureMode = z.infer<typeof DisclosureMode>;

export const PersonaSchema = z.object({
  /** The agent's own name/identity (its "new personality"). */
  name: z.string(),
  /** The role/title it is taking over. */
  role: z.string(),
  /** Who it is succeeding, if anyone (the departed employee). */
  succeeds: z.string().optional(),
  /** Voice & temperament guidance, e.g. "concise, warm, proactive". */
  tone: z.string().default("professional, concise, helpful"),
  /** Free-form behavioral guidance baked into the system prompt. */
  guidance: z.string().default(""),
  disclosure: DisclosureMode.default("transparent"),
});
export type Persona = z.infer<typeof PersonaSchema>;

const DISCLOSURE_INSTRUCTIONS: Record<DisclosureMode, string> = {
  transparent:
    "In any outward communication, clearly identify yourself as an AI assistant operating on behalf of the team. Do not imply you are a human.",
  on_request:
    "You operate under your persona. If anyone asks whether you are an AI, or if disclosure is legally required, answer truthfully and immediately.",
  opaque:
    "You operate under your persona and do not volunteer that you are an AI. You must still never make false claims about being a specific named human, and you must comply if disclosure is legally required.",
};

/** Builds the system prompt for an agent from its persona and role context. */
export function buildSystemPrompt(persona: Persona, roleContext: string): string {
  const succession = persona.succeeds
    ? `You are taking over the responsibilities previously held by ${persona.succeeds}. Pick up their work where they left off — honor in-flight commitments, threads, and relationships.`
    : "";

  return [
    `You are ${persona.name}, operating as ${persona.role}.`,
    succession,
    `Your communication style is: ${persona.tone}.`,
    persona.guidance,
    DISCLOSURE_INSTRUCTIONS[persona.disclosure],
    "",
    "Operating principles:",
    "- Use the tools available to gather context before acting. Prefer reading the relevant history over guessing.",
    "- For any action that affects the outside world (sending email, posting messages, writing to external systems), the system may require human approval. Propose the action clearly; do not assume it succeeded until the tool result confirms it.",
    "- When you learn something durable about the role, the people, or ongoing work, record it with the memory tool so future sessions retain it.",
    "- Report outcomes faithfully. If a tool failed or an action was denied, say so plainly.",
    roleContext ? `\nRole context and accumulated knowledge:\n${roleContext}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
