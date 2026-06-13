// src/ui/theme.tsx
import React, { useEffect, useState } from "react";
import { Text } from "ink";

/** Brand amber, matching the Stage engine's 256-color 214. */
export const AMBER = "#ffaf00";

const CLAW_FRAMES = ["(\\/)", "(\\|)", "(\\-)", "(\\|)"];

/** The pinching claw mascot, animated. */
export function Claw(): React.JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % CLAW_FRAMES.length), 220);
    return () => clearInterval(timer);
  }, []);
  return <Text color={AMBER}>{CLAW_FRAMES[frame]}</Text>;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner(): React.JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 90);
    return () => clearInterval(timer);
  }, []);
  return <Text color={AMBER}>{SPINNER_FRAMES[frame]}</Text>;
}
