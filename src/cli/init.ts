import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { availableConnectorIds } from "../connectors/index.js";
import { AgentConfigSchema } from "../agent/config.js";
import { ConfigError } from "../core/errors.js";
import { dim } from "./render.js";

export interface InitFlags {
  id?: string;
  name?: string;
  role?: string;
  succeeds?: string;
  tone?: string;
  guidance?: string;
  disclosure?: string;
  connectors?: string;
  force?: boolean;
  yes?: boolean;
}

/**
 * Scaffolds an agent config JSON. Values can come from flags; anything
 * missing is prompted for interactively (unless --yes, which takes defaults).
 */
export async function runInit(path: string, flags: InitFlags): Promise<void> {
  if (!flags.force) {
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    if (exists) throw new ConfigError(`${path} already exists (use --force to overwrite)`);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (label: string, fallback?: string, required = false): Promise<string> => {
    if (flags.yes) return fallback ?? "";
    for (;;) {
      const suffix = fallback ? ` ${dim(`(${fallback})`)}` : required ? ` ${dim("(required)")}` : ` ${dim("(optional)")}`;
      const answer = (await rl.question(`${label}${suffix}: `)).trim();
      if (answer) return answer;
      if (fallback !== undefined) return fallback;
      if (!required) return "";
      stdout.write(dim("  this field is required\n"));
    }
  };

  try {
    const defaultId = basename(path)
      .replace(/\.json$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-");

    const id = flags.id ?? (await ask("agent id", defaultId));
    const name = flags.name ?? (await ask("persona name (the agent's own identity)", undefined, true));
    const role = flags.role ?? (await ask("role it takes over", undefined, true));
    const succeeds = flags.succeeds ?? (await ask("who it succeeds (the departed employee)"));
    const tone = flags.tone ?? (await ask("tone", "professional, concise, helpful"));
    const guidance = flags.guidance ?? (await ask("extra guidance"));

    const disclosure =
      flags.disclosure ??
      (await ask(`disclosure ${dim("transparent | on_request | opaque")}`, "transparent"));

    const known = availableConnectorIds();
    const connectorsRaw = flags.connectors ?? (await ask(`connectors ${dim(`any of: ${known.join(", ")}`)}`, ""));
    const connectors = connectorsRaw
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    for (const c of connectors) {
      if (!known.includes(c)) throw new ConfigError(`unknown connector "${c}" (available: ${known.join(", ")})`);
    }

    const config = {
      id,
      persona: {
        name,
        role,
        ...(succeeds ? { succeeds } : {}),
        tone,
        ...(guidance ? { guidance } : {}),
        disclosure,
      },
      effort: "high",
      connectors,
      maxIterations: 25,
    };

    const parsed = AgentConfigSchema.safeParse(config);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new ConfigError(`invalid agent config:\n${issues}`);
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    stdout.write(`\nWrote ${path}\n`);
    stdout.write(dim(`Try it:  npm run dev -- chat ${path}\n`));
    if (connectors.length > 0) {
      stdout.write(dim(`Connector credentials needed — check:  npm run dev -- connectors\n`));
    }
  } finally {
    rl.close();
  }
}
