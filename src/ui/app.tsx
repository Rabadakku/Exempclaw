// src/ui/app.tsx
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { Services } from "./services.js";
import type { RegisteredAgent, BrokenAgent } from "../agents/registry.js";
import { HomeScreen } from "./screens/home.js";
import { AgentsScreen } from "./screens/agents.js";
import { AgentScreen } from "./screens/agent.js";
import { CreateScreen } from "./screens/create.js";
import { HistoryScreen } from "./screens/history.js";
import { PluginsScreen } from "./screens/plugins.js";
import { DoctorScreen } from "./screens/doctor.js";

export type Route =
  | { name: "home" }
  | { name: "agents" }
  | { name: "agent"; id: string }
  | { name: "create" }
  | { name: "history" }
  | { name: "plugins" }
  | { name: "doctor" };

/** ink has no built-in error boundary; render failures must not dump raw stacks mid-frame. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (this.state.error) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color="red">✖ Something went wrong: {this.state.error.message}</Text>
          <Text dimColor>Details may be in your data dir's logs. Press ctrl-c to exit.</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}

export function App({
  services,
  initialAgents,
  initialBroken,
}: {
  services: Services;
  initialAgents: RegisteredAgent[];
  initialBroken: BrokenAgent[];
}): React.JSX.Element {
  // Always open on the home dashboard; the user chooses "New agent" when ready.
  const [route, setRoute] = useState<Route>({ name: "home" });
  const [agents, setAgents] = useState(initialAgents);
  const [broken, setBroken] = useState(initialBroken);

  useEffect(() => {
    // Refresh the registry whenever we come back home (e.g. after the wizard).
    if (route.name !== "home") return;
    void services.listAgents().then(({ agents, broken }) => {
      setAgents(agents);
      setBroken(broken);
    });
  }, [route.name, services]);

  const screen = (() => {
    switch (route.name) {
      case "home":
        return <HomeScreen services={services} agents={agents} onNavigate={setRoute} />;
      case "agents":
        return <AgentsScreen services={services} onNavigate={setRoute} />;
      case "agent":
        return <AgentScreen services={services} agentId={route.id} onNavigate={setRoute} />;
      case "create":
        return <CreateScreen services={services} onNavigate={setRoute} />;
      case "history":
        return <HistoryScreen services={services} onNavigate={setRoute} />;
      case "plugins":
        return <PluginsScreen services={services} onNavigate={setRoute} />;
      case "doctor":
        return <DoctorScreen onNavigate={setRoute} />;
    }
  })();

  return (
    <ErrorBoundary>
      {broken.length > 0 && route.name === "home" ? (
        <Box paddingX={1}>
          <Text color="yellow">! {broken.length} agent config(s) failed to load — see Agents</Text>
        </Box>
      ) : null}
      {screen}
    </ErrorBoundary>
  );
}
