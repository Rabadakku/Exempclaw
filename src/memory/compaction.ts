import type Anthropic from "@anthropic-ai/sdk";

/**
 * Client-side history compaction. When a conversation outgrows the context
 * budget, the older portion is summarized into a single exchange and the
 * recent turns are kept verbatim. The cut point is chosen so tool_use /
 * tool_result pairs are never split.
 */

export interface CompactionOptions {
  /** Roughly how many trailing messages to keep verbatim. Default 8. */
  keepRecent?: number;
  /** Produces the summary text for the compacted transcript. */
  summarize: (transcript: string) => Promise<string>;
}

export async function compactHistory(
  messages: Anthropic.MessageParam[],
  opts: CompactionOptions,
): Promise<Anthropic.MessageParam[]> {
  const keepRecent = opts.keepRecent ?? 8;
  const cut = findCutIndex(messages, keepRecent);
  if (cut === null || cut <= 1) return messages;

  const transcript = renderTranscript(messages.slice(0, cut));
  const summary = await opts.summarize(transcript);

  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `<conversation_summary>\n${summary}\n</conversation_summary>\nEarlier turns of this conversation were compacted into the summary above. Continue from it as if you lived through those turns.`,
        },
      ],
    },
    { role: "assistant", content: "Understood — I have the summary of the earlier conversation and will continue from it." },
    ...messages.slice(cut),
  ];
}

/**
 * Finds the earliest valid boundary at or after (length - keepRecent): the
 * boundary message must be a user turn that is not a tool_result follow-up,
 * so the kept tail never references a tool_use that was summarized away.
 */
export function findCutIndex(messages: Anthropic.MessageParam[], keepRecent: number): number | null {
  const target = messages.length - keepRecent;
  if (target <= 1) return null;
  for (let i = target; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return i;
    const hasToolResult = msg.content.some((b) => b.type === "tool_result");
    if (!hasToolResult) return i;
  }
  return null;
}

/** Renders messages into a plain-text transcript for the summarizer. */
export function renderTranscript(messages: Anthropic.MessageParam[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      lines.push(`${msg.role.toUpperCase()}: ${msg.content}`);
      continue;
    }
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          lines.push(`${msg.role.toUpperCase()}: ${block.text}`);
          break;
        case "tool_use":
          lines.push(`${msg.role.toUpperCase()} called ${block.name}(${truncate(JSON.stringify(block.input), 400)})`);
          break;
        case "tool_result": {
          const content =
            typeof block.content === "string"
              ? block.content
              : (block.content ?? [])
                  .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
                  .join(" ");
          lines.push(`TOOL RESULT${block.is_error ? " (error)" : ""}: ${truncate(content, 600)}`);
          break;
        }
        default:
          // thinking blocks and other internals are deliberately omitted
          break;
      }
    }
  }
  return lines.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
