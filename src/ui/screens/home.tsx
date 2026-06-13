import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { Claw, AMBER } from "../theme.js";
import { MenuList } from "../components/menu.js";
import { KeyHints } from "../components/key-hints.js";
import { sparkline, bar, money } from "../components/chart.js";
import { loadFleetStats, type FleetStats } from "../dashboard-data.js";
import { timeAgo } from "../agents-data.js";
import type { Services } from "../services.js";
import type { RegisteredAgent } from "../../agents/registry.js";
import type { Route } from "../app.js";

const CYAN = "#36d3c8";
const GREEN = "#7CE38B";
const MAGENTA = "#c792ea";

const EMPTY_STATS: FleetStats = {
  totalRuns: 0,
  totalSpendUsd: 0,
  spendTodayUsd: 0,
  runsPerDay: [0, 0, 0, 0, 0, 0, 0],
  spendByAgent: [],
  recent: [],
};

/** Truncate/pad a label to a fixed width so columns line up. */
function fit(text: string, width: number): string {
  if (text.length === width) return text;
  if (text.length > width) return `${text.slice(0, width - 1)}…`;
  return text.padEnd(width);
}

function StatCard({
  label,
  value,
  accent,
  spark,
  sub,
}: {
  label: string;
  value: string;
  accent: string;
  spark?: string;
  sub?: string;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} width={18}>
      <Text dimColor>{label}</Text>
      <Text bold color={accent}>
        {value}
      </Text>
      {spark ? <Text color={accent}>{spark}</Text> : <Text dimColor>{sub ?? " "}</Text>}
    </Box>
  );
}

function Panel({
  title,
  width,
  children,
}: {
  title: string;
  width: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width={width}>
      <Text bold dimColor>
        {title}
      </Text>
      {children}
    </Box>
  );
}

export function HomeScreen({
  services,
  agents,
  onNavigate,
}: {
  services: Services;
  agents: RegisteredAgent[];
  onNavigate: (route: Route) => void;
}): React.JSX.Element {
  const { exit } = useApp();
  const [stats, setStats] = useState<FleetStats>(EMPTY_STATS);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    let live = true;
    void loadFleetStats(services.config.dataDir).then((s) => {
      if (live) setStats(s);
    });
    return () => {
      live = false;
    };
  }, [services]);

  // Drives the live clock + heartbeat pulse (the claw animates on its own timer).
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 500);
    timer.unref?.();
    return () => clearInterval(timer);
  }, []);

  const pluginCount = services.plugins.plugins.length;
  const pluginFailures = services.applied.failures.length;
  const toolCount = services.plugins.plugins.reduce((n, p) => n + (p.spec.tools?.length ?? 0), 0);
  const channels = agents.reduce((n, a) => n + a.config.connectors.length, 0);
  const names = new Map(agents.map((a) => [a.config.id, a.config.persona.name]));

  const clock = new Date().toTimeString().slice(0, 8);
  const pulseOn = frame % 2 === 0;
  const maxSpend = Math.max(...stats.spendByAgent.map((a) => a.spendUsd), 0.000001);

  const items = [
    { value: "agents", label: "Agents", hint: `${agents.length} configured` },
    { value: "create", label: "New agent", hint: "guided setup" },
    { value: "history", label: "History", hint: `${stats.totalRuns} runs` },
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
      {/* Banner: mascot + wordmark on the left, heartbeat + clock on the right */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Box gap={1}>
          <Claw />
          <Text bold color={AMBER}>
            E X E M P C L A W
          </Text>
          <Text dimColor>· fleet command center</Text>
        </Box>
        <Box gap={2}>
          <Text color={pulseOn ? GREEN : "gray"}>{pulseOn ? "●" : "○"} live</Text>
          <Text dimColor>◷ {clock}</Text>
        </Box>
      </Box>

      {/* Stat widgets */}
      <Box gap={1}>
        <StatCard
          accent={CYAN}
          label="AGENTS"
          value={String(agents.length)}
          sub={`${channels} channel${channels === 1 ? "" : "s"}`}
        />
        <StatCard accent={AMBER} label="RUNS · 7d" value={String(stats.totalRuns)} spark={sparkline(stats.runsPerDay)} />
        <StatCard accent={GREEN} label="SPEND" value={money(stats.totalSpendUsd)} sub={`${money(stats.spendTodayUsd)} today`} />
        <StatCard
          accent={MAGENTA}
          label="PLUGINS"
          value={String(pluginCount)}
          sub={pluginFailures ? `${pluginFailures} broken` : `${toolCount} tool${toolCount === 1 ? "" : "s"}`}
        />
      </Box>

      {/* Charts: top agents by spend + recent activity */}
      <Box gap={1} marginTop={1}>
        <Panel title="TOP AGENTS" width={37}>
          {stats.spendByAgent.length === 0 ? (
            <Text dimColor>No runs yet — press ↵ on “New agent”.</Text>
          ) : (
            stats.spendByAgent.slice(0, 4).map((a) => (
              <Text key={a.id}>
                {fit(names.get(a.id) ?? a.id, 9)} <Text color={AMBER}>{bar(a.spendUsd, maxSpend, 10)}</Text>{" "}
                <Text dimColor>{money(a.spendUsd)}</Text>
              </Text>
            ))
          )}
        </Panel>
        <Panel title="RECENT ACTIVITY" width={37}>
          {stats.recent.length === 0 ? (
            <Text dimColor>Quiet so far. Chat with an agent →</Text>
          ) : (
            stats.recent.slice(0, 4).map((r) => {
              const mark = r.error ? "✗" : r.outwardActions.some((x) => x.approved) ? "✉" : "✓";
              const markColor = r.error ? "red" : "green";
              return (
                <Text key={r.runId + r.startedAt}>
                  <Text dimColor>{fit(timeAgo(r.startedAt), 7)}</Text> {fit(names.get(r.agentId) ?? r.agentId, 8)}{" "}
                  <Text dimColor>{fit(r.trigger.kind, 6)}</Text> <Text color={markColor}>{mark}</Text>
                </Text>
              );
            })
          )}
        </Panel>
      </Box>

      {/* Navigation */}
      <Box marginTop={1}>
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
      </Box>
      <KeyHints hints={["↑↓ move", "enter select", "q quit"]} />
    </Box>
  );
}
