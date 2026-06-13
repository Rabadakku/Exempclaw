import React from "react";
import { Box, Text, useInput } from "ink";
import { doctorChecks } from "../doctor-data.js";
import { KeyHints } from "../components/key-hints.js";
import type { Route } from "../app.js";

export function DoctorScreen({ onNavigate }: { onNavigate: (route: Route) => void }): React.JSX.Element {
  const checks = doctorChecks();
  useInput((input, key) => {
    if (key.escape || input === "q") onNavigate({ name: "home" });
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Doctor</Text>
      <Box flexDirection="column" marginTop={1}>
        {checks.map((check) => (
          <Box key={check.label} flexDirection="column">
            <Text color={check.ok ? "green" : "yellow"}>{check.ok ? "✓" : "!"} {check.label}</Text>
            {check.hint ? <Text dimColor>   {check.hint}</Text> : null}
          </Box>
        ))}
      </Box>
      <Text dimColor>For live connector probes, run: exempclaw doctor</Text>
      <KeyHints hints={["esc back"]} />
    </Box>
  );
}
