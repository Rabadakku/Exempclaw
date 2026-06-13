// src/ui/components/key-hints.tsx
import React from "react";
import { Box, Text } from "ink";

export function KeyHints({ hints }: { hints: string[] }): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text dimColor>{hints.join(" · ")}</Text>
    </Box>
  );
}
