import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { RunRecord } from "../../core/run-log.js";
import type { Services } from "../services.js";
import { loadFleetHistory } from "../history-data.js";
import { timeAgo } from "../agents-data.js";
import { AMBER } from "../theme.js";
import { KeyHints } from "../components/key-hints.js";
import type { Route } from "../app.js";

const PAGE = 15;

export function HistoryScreen({
  services,
  onNavigate,
}: {
  services: Services;
  onNavigate: (route: Route) => void;
}): React.JSX.Element {
  const [records, setRecords] = useState<RunRecord[]>();
  const [index, setIndex] = useState(0);
  const [detail, setDetail] = useState(false);

  useEffect(() => {
    void loadFleetHistory(services.config.dataDir).then(setRecords);
  }, [services]);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      if (detail) setDetail(false);
      else onNavigate({ name: "home" });
    } else if (!records || records.length === 0) {
      return;
    } else if (key.upArrow || input === "k") setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow || input === "j") setIndex((i) => Math.min(records.length - 1, i + 1));
    else if (key.return) setDetail(true);
  });

  if (!records) return <Text dimColor>loading history…</Text>;
  if (records.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>No runs yet. Chat with an agent and its runs will show up here.</Text>
        <KeyHints hints={["esc back"]} />
      </Box>
    );
  }

  const selected = records[index]!;
  if (detail) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={AMBER}>Run {selected.runId}</Text>
        <Text>agent: {selected.agentId} · trigger: {selected.trigger.kind}{selected.trigger.detail ? ` (${selected.trigger.detail})` : ""}</Text>
        <Text>when: {selected.startedAt} → {selected.finishedAt}</Text>
        <Text>model: {selected.model} · iterations: {selected.iterations} · stop: {selected.stopReason ?? "—"}</Text>
        <Text>cost: {selected.costUsd === null ? "unknown" : `$${selected.costUsd.toFixed(4)}`}</Text>
        {selected.outwardActions.length > 0 ? <Text bold>outward actions:</Text> : <Text dimColor>no outward actions</Text>}
        {selected.outwardActions.map((action, i) => (
          <Text key={i} color={action.approved ? "green" : "red"}>
            {action.approved ? "✓ approved" : "✗ denied"} {action.tool}: {action.summary}
          </Text>
        ))}
        {selected.error ? <Text color="red">error: {selected.error}</Text> : null}
        <KeyHints hints={["esc back to list"]} />
      </Box>
    );
  }

  const start = Math.max(0, Math.min(index - Math.floor(PAGE / 2), records.length - PAGE));
  const visible = records.slice(start, start + PAGE);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>History</Text>
      <Text dimColor>{records.length} run(s) across the fleet</Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((record, i) => {
          const absolute = start + i;
          const cost = record.costUsd === null ? "" : ` · $${record.costUsd.toFixed(3)}`;
          return (
            <Text key={record.runId + record.startedAt} color={absolute === index ? AMBER : undefined}>
              {absolute === index ? "❯" : " "} {timeAgo(record.startedAt)} · {record.agentId} · {record.trigger.kind}
              {record.error ? " · ✗ error" : ""}{cost}
            </Text>
          );
        })}
      </Box>
      <KeyHints hints={["↑↓ move", "enter details", "esc back"]} />
    </Box>
  );
}
