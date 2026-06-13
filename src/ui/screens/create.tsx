// src/ui/screens/create.tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { connectorStatuses } from "../../connectors/index.js";
import { saveAgent } from "../../agents/registry.js";
import type { Services } from "../services.js";
import { AMBER } from "../theme.js";
import { KeyHints } from "../components/key-hints.js";
import type { Route } from "../app.js";

const DISCLOSURE_OPTIONS = [
  { value: "transparent", label: "Transparent", blurb: "Always says it's an AI assistant. The safest default." },
  { value: "on_request", label: "On request", blurb: "Works under its persona; answers truthfully the moment anyone asks if it's an AI." },
  { value: "opaque", label: "Opaque", blurb: "Doesn't volunteer being an AI — but will never deny it when sincerely asked, and never claims to be a real named person. Use only where authorized and lawful." },
] as const;

type StepName = "name" | "role" | "succeeds" | "tone" | "disclosure" | "connectors" | "ingest" | "confirm" | "done";

export function CreateScreen({
  services,
  onNavigate,
}: {
  services: Services;
  onNavigate: (route: Route) => void;
}): React.JSX.Element {
  const [step, setStep] = useState<StepName>("name");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [succeeds, setSucceeds] = useState("");
  const [tone, setTone] = useState("professional, concise, helpful");
  const [disclosureIndex, setDisclosureIndex] = useState(0);
  const [connectorChecks, setConnectorChecks] = useState<Set<string>>(new Set());
  const [connectorIndex, setConnectorIndex] = useState(0);
  const [ingestDir, setIngestDir] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const [error, setError] = useState("");
  const [field, setField] = useState("");

  const statuses = connectorStatuses().filter((s) => s.id !== "demo");
  const agentId = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";

  useInput((input, key) => {
    if (key.escape) {
      onNavigate({ name: "home" });
      return;
    }
    if (step === "disclosure") {
      if (key.upArrow) setDisclosureIndex((i) => (i + DISCLOSURE_OPTIONS.length - 1) % DISCLOSURE_OPTIONS.length);
      else if (key.downArrow) setDisclosureIndex((i) => (i + 1) % DISCLOSURE_OPTIONS.length);
      else if (key.return) setStep("connectors");
    } else if (step === "connectors") {
      if (key.upArrow) setConnectorIndex((i) => (i + statuses.length - 1) % Math.max(1, statuses.length));
      else if (key.downArrow) setConnectorIndex((i) => (i + 1) % Math.max(1, statuses.length));
      else if (input === " ") {
        const id = statuses[connectorIndex]?.id;
        if (!id || !statuses[connectorIndex]?.configured) return; // unconfigured: not selectable
        setConnectorChecks((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      } else if (key.return) setStep("ingest");
    } else if (step === "confirm") {
      if (input === "y" || key.return) void save();
      else if (input === "n") setStep("name");
    } else if (step === "done") {
      if (input === "c") onNavigate({ name: "agent", id: agentId });
      else if (key.return) onNavigate({ name: "home" });
    }
  });

  async function save() {
    try {
      const path = await saveAgent(services.agentsDir, {
        id: agentId,
        persona: {
          name: name.trim(),
          role: role.trim(),
          ...(succeeds.trim() ? { succeeds: succeeds.trim() } : {}),
          tone,
          guidance: "",
          disclosure: DISCLOSURE_OPTIONS[disclosureIndex]!.value,
        },
        connectors: [...connectorChecks],
        schedules: [],
      });
      setSavedPath(path);
      setStep("done");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const textStep = (
    title: string,
    blurb: string,
    value: string,
    setValue: (v: string) => void,
    next: StepName,
    options?: { allowEmpty?: boolean; placeholder?: string },
  ) => (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dimColor>{blurb}</Text>
      <Box gap={1} marginTop={1}>
        <Text color={AMBER}>▸</Text>
        <TextInput
          value={field}
          onChange={setField}
          placeholder={options?.placeholder ?? value}
          onSubmit={(submitted) => {
            const finalValue = submitted.trim() || value;
            if (!finalValue && !options?.allowEmpty) return;
            setValue(finalValue);
            setField("");
            setStep(next);
          }}
        />
      </Box>
    </Box>
  );

  let body: React.JSX.Element;
  switch (step) {
    case "name":
      body = textStep("What's the agent's name?", "Its own identity — e.g. \"Sam\". Used everywhere it speaks.", name, setName, "role");
      break;
    case "role":
      body = textStep("What role is it taking over?", "E.g. \"Sales Development Rep\" or \"Support triage\".", role, setRole, "succeeds");
      break;
    case "succeeds":
      body = textStep("Who is it succeeding? (optional — enter to skip)", "The departed employee whose work it inherits.", succeeds, setSucceeds, "tone", { allowEmpty: true, placeholder: "(skip)" });
      break;
    case "tone":
      body = textStep("How should it sound?", "Voice & temperament — enter keeps the default.", tone, setTone, "disclosure", { placeholder: tone });
      break;
    case "disclosure":
      body = (
        <Box flexDirection="column">
          <Text bold>How openly does it identify as an AI?</Text>
          {DISCLOSURE_OPTIONS.map((option, i) => (
            <Box key={option.value} flexDirection="column" marginTop={i === 0 ? 1 : 0}>
              <Text color={i === disclosureIndex ? AMBER : undefined}>
                {i === disclosureIndex ? "❯" : " "} {option.label}
              </Text>
              <Text dimColor>   {option.blurb}</Text>
            </Box>
          ))}
        </Box>
      );
      break;
    case "connectors":
      body = (
        <Box flexDirection="column">
          <Text bold>Which channels can it use? (space toggles, enter continues)</Text>
          {statuses.map((status, i) => (
            <Box key={status.id} gap={1}>
              <Text color={i === connectorIndex ? AMBER : undefined}>
                {i === connectorIndex ? "❯" : " "} [{connectorChecks.has(status.id) ? "x" : " "}] {status.id}
              </Text>
              <Text dimColor>
                {status.configured
                  ? status.description
                  : `needs ${status.envKeys.filter((k) => k.required && !k.set).map((k) => k.env).join(", ")} in .env`}
              </Text>
            </Box>
          ))}
          {statuses.length === 0 ? <Text dimColor>No connectors configured — you can add them later.</Text> : null}
        </Box>
      );
      break;
    case "ingest":
      body = textStep(
        "Got a folder of their old files? (optional — enter to skip)",
        "Emails, docs, exports. After creating, run the suggested ingest command to distill them into memory.",
        ingestDir,
        setIngestDir,
        "confirm",
        { allowEmpty: true, placeholder: "(skip)" },
      );
      break;
    case "confirm":
      body = (
        <Box flexDirection="column">
          <Text bold>Create this agent?</Text>
          <Text>  {name} — {role}{succeeds ? ` (succeeding ${succeeds})` : ""}</Text>
          <Text>  disclosure: {DISCLOSURE_OPTIONS[disclosureIndex]!.label.toLowerCase()} · connectors: {[...connectorChecks].join(", ") || "none"}</Text>
          <Text>  saving to {services.agentsDir}/{agentId}.json</Text>
          {error ? <Text color="red">✖ {error}</Text> : null}
          <Box marginTop={1}>
            <Text>[y]es create / [n]o start over / esc cancel</Text>
          </Box>
        </Box>
      );
      break;
    case "done":
      body = (
        <Box flexDirection="column">
          <Text color="green">✓ Created {savedPath}</Text>
          {ingestDir ? (
            <Text dimColor>To distill their old files: exempclaw ingest {savedPath} {ingestDir}</Text>
          ) : null}
          <Text>[c] chat with {name} now · enter for home</Text>
        </Box>
      );
      break;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={AMBER}>New agent</Text>
      <Box marginTop={1}>{body}</Box>
      <KeyHints hints={["esc cancel"]} />
    </Box>
  );
}
