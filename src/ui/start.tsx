// src/ui/start.tsx
import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import { createServices } from "./services.js";

export async function startUi(): Promise<void> {
  const services = await createServices();
  const { agents, broken } = await services.listAgents();
  const { waitUntilExit } = render(
    <App services={services} initialAgents={agents} initialBroken={broken} />,
    { exitOnCtrlC: true },
  );
  try {
    await waitUntilExit();
  } finally {
    await services.shutdown();
  }
}
