import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Services } from "../services.js";
import { defaultPluginsDir } from "../../plugins/loader.js";
import { scaffoldPlugin } from "../../plugins/scaffold.js";
import { AMBER } from "../theme.js";
import { KeyHints } from "../components/key-hints.js";
import type { Route } from "../app.js";

export function PluginsScreen({
  services,
  onNavigate,
}: {
  services: Services;
  onNavigate: (route: Route) => void;
}): React.JSX.Element {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");

  useInput((input, key) => {
    if (creating) return; // TextInput owns the keyboard
    if (key.escape || input === "q") onNavigate({ name: "home" });
    else if (input === "n") setCreating(true);
  });

  const submit = async (value: string) => {
    try {
      const dir = await scaffoldPlugin(defaultPluginsDir(), value.trim());
      setMessage(`✓ Created ${dir} — edit index.js, then restart exempclaw to load it.`);
    } catch (err) {
      setMessage(`✖ ${(err as Error).message}`);
    }
    setCreating(false);
    setName("");
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Plugins</Text>
      <Text dimColor>{defaultPluginsDir()}</Text>
      <Box flexDirection="column" marginTop={1}>
        {services.plugins.plugins.length === 0 && services.applied.failures.length === 0 ? (
          <Text dimColor>No plugins installed. Press n to scaffold one.</Text>
        ) : null}
        {services.plugins.plugins.map((plugin) => {
          const provides = [
            plugin.spec.tools?.length ? `${plugin.spec.tools.length} tool(s)` : "",
            plugin.spec.connectors?.length ? `${plugin.spec.connectors.length} connector(s)` : "",
          ].filter(Boolean).join(", ");
          return (
            <Text key={plugin.dir}>
              <Text color="green">✓ </Text>
              <Text bold>{plugin.manifest.name}</Text> {plugin.manifest.version} <Text dimColor>{provides || "nothing exported"}</Text>
            </Text>
          );
        })}
        {services.applied.failures.map((failure) => (
          <Text key={failure.dir} color="red">✗ {failure.name} — {failure.error}</Text>
        ))}
      </Box>
      {creating ? (
        <Box gap={1} marginTop={1}>
          <Text color={AMBER}>name ▸</Text>
          <TextInput value={name} onChange={setName} onSubmit={(v) => void submit(v)} placeholder="my-plugin" />
        </Box>
      ) : null}
      {message ? <Box marginTop={1}><Text>{message}</Text></Box> : null}
      <KeyHints hints={creating ? ["enter create"] : ["n new plugin", "esc back"]} />
    </Box>
  );
}
