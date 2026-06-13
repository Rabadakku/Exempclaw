import { connectorStatuses } from "../connectors/index.js";

export interface DoctorCheck {
  label: string;
  ok: boolean;
  hint?: string;
}

export function doctorChecks(env: NodeJS.ProcessEnv = process.env): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    label: `Node ${process.versions.node}`,
    ok: major >= 22,
    hint: major >= 22 ? undefined : "Exempclaw needs Node 22+ — install from https://nodejs.org",
  });
  checks.push({
    label: "ANTHROPIC_API_KEY",
    ok: Boolean(env.ANTHROPIC_API_KEY),
    hint: env.ANTHROPIC_API_KEY
      ? undefined
      : "Add ANTHROPIC_API_KEY to .env — get a key at console.anthropic.com. (No key? Try `exempclaw demo`.)",
  });
  for (const status of connectorStatuses(env)) {
    if (status.id === "demo") continue;
    const missing = status.envKeys.filter((k) => k.required && !k.set).map((k) => k.env);
    checks.push({
      label: `connector: ${status.id}`,
      ok: status.configured,
      hint: status.configured ? undefined : `optional — set ${missing.join(", ")} in .env to enable`,
    });
  }
  return checks;
}
