// src/ui/components/menu.tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { AMBER } from "../theme.js";

export interface MenuItem {
  value: string;
  label: string;
  hint?: string;
}

export function MenuList({
  items,
  onSelect,
  onBack,
}: {
  items: MenuItem[];
  onSelect: (value: string) => void;
  onBack?: () => void;
}): React.JSX.Element {
  const [index, setIndex] = useState(0);
  useInput((input, key) => {
    if (key.upArrow || input === "k") setIndex((i) => (i + items.length - 1) % items.length);
    else if (key.downArrow || input === "j") setIndex((i) => (i + 1) % items.length);
    else if (key.return && items[index]) onSelect(items[index]!.value);
    else if ((key.escape || input === "q") && onBack) onBack();
  });
  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Box key={item.value} gap={2}>
          <Text color={i === index ? AMBER : undefined}>
            {i === index ? "❯" : " "} {item.label}
          </Text>
          {item.hint ? <Text dimColor>{item.hint}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}
