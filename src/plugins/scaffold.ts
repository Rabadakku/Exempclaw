import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes a working, zero-install plugin template: the entry default-exports a
 * factory receiving the plugin API, so nothing needs `npm install` to run.
 */
export async function scaffoldPlugin(pluginsDir: string, name: string): Promise<string> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`plugin name must be lowercase letters/digits/dashes, got "${name}"`);
  }
  const dir = join(pluginsDir, name);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  await mkdir(dir, { recursive: true });

  await writeFile(
    join(dir, "exempclaw.plugin.json"),
    `${JSON.stringify({ name, version: "0.1.0", description: `${name} plugin`, entry: "./index.js" }, null, 2)}\n`,
    "utf8",
  );

  await writeFile(
    join(dir, "index.js"),
    `/**
 * Exempclaw plugin: ${name}
 *
 * The default export is a factory that receives Exempclaw's plugin API
 * ({ z, defineTool, definePlugin }), so this file works with zero installs.
 * See PLUGIN.md for the full interface, including connectors.
 */
export default function ({ z, defineTool, definePlugin }) {
  return definePlugin({
    name: "${name}",
    tools: [
      defineTool({
        name: "${name}_hello",
        description: "Example tool — replace with your own. Tools that act on the outside world must set outward: true so the approval gate engages.",
        schema: z.object({ who: z.string().describe("Who to greet") }),
        execute: async ({ who }) => ({ content: \`Hello, \${who}! (from the ${name} plugin)\` }),
      }),
    ],
  });
}
`,
    "utf8",
  );

  await writeFile(
    join(dir, "PLUGIN.md"),
    `# ${name} — an Exempclaw plugin

Exempclaw discovers plugins in this folder's parent directory at startup
(\`~/.exempclaw/plugins\` by default, override with \`EXEMPCLAW_PLUGINS_DIR\`).

## Anatomy

- \`exempclaw.plugin.json\` — name, version, description, entry (path to the module).
- the entry module — default-exports either:
  1. **a factory** \`(api) => spec\` (this template): \`api\` is \`{ z, defineTool, definePlugin }\`.
     Zero installs needed.
  2. **a spec object** built with \`import { definePlugin } from "exempclaw/plugin"\` —
     for TypeScript authors; run \`npm i exempclaw zod\` in this folder and compile to JS.

## What a plugin can provide

- **tools**: capabilities every agent can call. Same shape as built-ins:
  \`defineTool({ name, description, schema, outward, execute })\`. Set \`outward: true\`
  for anything that touches the outside world — that engages the human-approval gate.
- **connectors**: full integrations (tools + inbound events). Provide
  \`{ id, description, envKeys, make }\` where \`make()\` returns an object implementing
  the \`Connector\` interface (\`init\`, \`tools\`, optional \`listen\`/\`shutdown\`).
  Agents opt in by listing your connector id in their config's \`connectors\` array.

## Rules

- A broken plugin never crashes Exempclaw — it shows up on the Plugins screen with the error.
- Plugins cannot change the LLM. Exempclaw runs on the Claude API only.

Check your work: run \`exempclaw\` and open **Plugins** — your plugin should be listed
with its tools, or shown with a load error to fix.
`,
    "utf8",
  );

  return dir;
}
