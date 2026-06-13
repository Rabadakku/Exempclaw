// src/ui/screens/home.tsx
import React from "react";
import { Box, Text, useApp } from "ink";
import { Claw } from "../theme.js";
import { MenuList } from "../components/menu.js";
import { KeyHints } from "../components/key-hints.js";
import type { Route } from "../app.js";

export function HomeScreen({
  agentCount,
  pluginCount,
  pluginFailures,
  onNavigate,
}: {
  agentCount: number;
  pluginCount: number;
  pluginFailures: number;
  onNavigate: (route: Route) => void;
}): React.JSX.Element {
  const { exit } = useApp();
  const items = [
    { value: "agents", label: "Agents", hint: `${agentCount} configured` },
    { value: "create", label: "New agent", hint: "guided setup" },
    { value: "history", label: "History", hint: "all runs, all agents" },
    {
      value: "plugins",
      label: "Plugins",
      hint: `${pluginCount} installed${pluginFailures ? `, ${pluginFailures} broken` : ""}`,
    },
    { value: "doctor", label: "Doctor", hint: "check my setup" },
    { value: "quit", label: "Quit" },
  ];
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={1} marginBottom={1}>
        <Claw />
        <Text bold color="#ffaf00">E X E M P C L A W</Text>
        <Text dimColor>fleet command</Text>
      </Box>
      <MenuList
        items={items}
        onSelect={(value) => {
          if (value === "quit") exit();
          else if (value === "agents") onNavigate({ name: "agents" });
          else if (value === "create") onNavigate({ name: "create" });
          else if (value === "history") onNavigate({ name: "history" });
          else if (value === "plugins") onNavigate({ name: "plugins" });
          else if (value === "doctor") onNavigate({ name: "doctor" });
        }}
        onBack={() => exit()}
      />
      <KeyHints hints={["↑↓ move", "enter select", "q quit"]} />
    </Box>
  );
}
