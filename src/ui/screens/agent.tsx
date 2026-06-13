// src/ui/screens/agent.tsx
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Orchestrator } from "../../orchestrator/orchestrator.js";
import type { Services, PendingApproval } from "../services.js";
import { AMBER, Spinner } from "../theme.js";
import { KeyHints } from "../components/key-hints.js";
import { toolIcon } from "../../cli/tui.js";
import type { Route } from "../app.js";

type Entry =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "tool"; name: string; ok?: boolean; detail?: string }
  | { kind: "status"; text: string }
  | { kind: "error"; text: string };

export function AgentScreen({
  services,
  agentId,
  onNavigate,
}: {
  services: Services;
  agentId: string;
  onNavigate: (route: Route) => void;
}): React.JSX.Element {
  const [orchestrator, setOrchestrator] = useState<Orchestrator>();
  const [bootError, setBootError] = useState<string>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<PendingApproval | undefined>();
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    services.getOrchestrator().then(setOrchestrator, (err: Error) => setBootError(err.message));
    return services.approvals.subscribe(setPending);
  }, [services]);

  useInput((inputChar, key) => {
    if (pending) return; // the approval dialog owns input
    if (key.escape) {
      if (running && abortRef.current) abortRef.current.abort();
      else onNavigate({ name: "agents" });
    }
  });

  const append = (entry: Entry) => setEntries((prev) => [...prev, entry]);
  const appendText = (delta: string) =>
    setEntries((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "agent") {
        return [...prev.slice(0, -1), { kind: "agent", text: last.text + delta }];
      }
      return [...prev, { kind: "agent", text: delta }];
    });

  const submit = (text: string) => {
    if (!orchestrator || running || !text.trim()) return;
    setInput("");
    append({ kind: "user", text });
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    orchestrator
      .dispatch(agentId, text, {
        trigger: { kind: "chat", detail: "tui" },
        signal: controller.signal,
        hooks: {
          onText: appendText,
          onToolStart: (name) => append({ kind: "tool", name }),
          onToolEnd: (name, ok, detail) =>
            setEntries((prev) => {
              const i = prev.findLastIndex((e) => e.kind === "tool" && e.name === name && e.ok === undefined);
              if (i < 0) return prev;
              const next = [...prev];
              next[i] = { kind: "tool", name, ok, detail };
              return next;
            }),
          onStatus: (_activity, message) => append({ kind: "status", text: message }),
        },
      })
      .catch((err: Error) => append({ kind: "error", text: err.message }))
      .finally(() => setRunning(false));
  };

  if (bootError) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="red">✖ {bootError}</Text>
        <Text dimColor>Add ANTHROPIC_API_KEY to .env — get a key at console.anthropic.com. esc to go back.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={AMBER}>{agentId}</Text>
      <Box flexDirection="column" marginTop={1}>
        {entries.map((entry, i) => {
          switch (entry.kind) {
            case "user":
              return <Text key={i} bold>you ▸ {entry.text}</Text>;
            case "agent":
              return <Text key={i}>{entry.text}</Text>;
            case "tool":
              return (
                <Text key={i} dimColor>
                  {toolIcon(entry.name)} {entry.name} {entry.ok === undefined ? "…" : entry.ok ? "✓" : `✗ ${entry.detail ?? ""}`}
                </Text>
              );
            case "status":
              return <Text key={i} color={AMBER}>≋ {entry.text}</Text>;
            case "error":
              return <Text key={i} color="red">✖ {entry.text}</Text>;
          }
        })}
      </Box>
      {pending ? (
        <ApprovalDialog pending={pending} />
      ) : running ? (
        <Box gap={1}><Spinner /><Text dimColor>working — esc to interrupt</Text></Box>
      ) : (
        <Box gap={1}>
          <Text color={AMBER}>▸</Text>
          <TextInput value={input} onChange={setInput} onSubmit={submit} placeholder="Say something… (esc to go back)" />
        </Box>
      )}
      <KeyHints hints={pending ? ["y approve", "n deny"] : ["enter send", "esc back/interrupt"]} />
    </Box>
  );
}

function ApprovalDialog({ pending }: { pending: PendingApproval }): React.JSX.Element {
  useInput((input) => {
    if (input === "y") pending.resolve(true);
    else if (input === "n") pending.resolve(false);
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">⚠ Approval required — {pending.req.tool}</Text>
      <Text bold>{pending.req.summary}</Text>
      <Text dimColor>{pending.req.detail}</Text>
      <Text>Approve? [y]es / [n]o</Text>
    </Box>
  );
}
