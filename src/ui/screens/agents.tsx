// src/ui/screens/agents.tsx
import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Services } from "../services.js";
import type { RegisteredAgent, BrokenAgent } from "../../agents/registry.js";
import { agentActivity, timeAgo, type AgentActivity } from "../agents-data.js";
import { MenuList } from "../components/menu.js";
import { KeyHints } from "../components/key-hints.js";
import type { Route } from "../app.js";

export function AgentsScreen({
  services,
  onNavigate,
}: {
  services: Services;
  onNavigate: (route: Route) => void;
}): React.JSX.Element {
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [broken, setBroken] = useState<BrokenAgent[]>([]);
  const [activity, setActivity] = useState<Map<string, AgentActivity>>(new Map());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      const listed = await services.listAgents();
      setAgents(listed.agents);
      setBroken(listed.broken);
      const entries = await Promise.all(
        listed.agents.map(async (a) => [a.config.id, await agentActivity(services.config.dataDir, a.config.id)] as const),
      );
      setActivity(new Map(entries));
      setLoaded(true);
    })();
  }, [services]);

  if (!loaded) return <Text dimColor>loading agents…</Text>;

  if (agents.length === 0 && broken.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>No agents yet.</Text>
        <Text dimColor>Pick "New agent" on the home screen for a guided setup.</Text>
        <BackInput onBack={() => onNavigate({ name: "home" })} />
        <KeyHints hints={["esc back"]} />
      </Box>
    );
  }

  const items = agents.map((agent) => {
    const a = activity.get(agent.config.id);
    const connectors = agent.config.connectors.join(",") || "no connectors";
    const spend = a && a.totalCostUsd > 0 ? ` · $${a.totalCostUsd.toFixed(2)}` : "";
    return {
      value: agent.config.id,
      label: `${agent.config.persona.name} — ${agent.config.persona.role}`,
      hint: `${connectors} · last run ${timeAgo(a?.lastRunAt)}${spend}`,
    };
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Agents</Text>
      <Text dimColor>{services.agentsDir}</Text>
      <Box marginTop={1} flexDirection="column">
        <MenuList
          items={items}
          onSelect={(id) => onNavigate({ name: "agent", id })}
          onBack={() => onNavigate({ name: "home" })}
        />
      </Box>
      {broken.map((b) => (
        <Text key={b.path} color="yellow">! {b.path}: {b.error}</Text>
      ))}
      <KeyHints hints={["↑↓ move", "enter chat", "esc back"]} />
    </Box>
  );
}

function BackInput({ onBack }: { onBack: () => void }): null {
  useInput((input, key) => {
    if (key.escape || input === "q") onBack();
  });
  return null;
}
