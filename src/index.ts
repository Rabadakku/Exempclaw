#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command } from "commander";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./core/logger.js";
import { ExempclawError } from "./core/errors.js";
import { loadAgentConfig } from "./agent/config.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { availableConnectorIds } from "./connectors/index.js";
import { terminalApprover } from "./cli/approve.js";

const program = new Command();

program
  .name("exempclaw")
  .description("Run Claude-powered agents that take over a departed employee's role.")
  .version("0.1.0");

program
  .command("connectors")
  .description("List the connectors available to wire agents to.")
  .action(() => {
    stdout.write(`Available connectors:\n${availableConnectorIds().map((id) => `  - ${id}`).join("\n")}\n`);
  });

program
  .command("run")
  .description("Run a single agent on one input and print the result.")
  .argument("<agentConfig>", "path to an agent config JSON file")
  .argument("<input>", "the message / instruction to give the agent")
  .action(async (agentConfigPath: string, input: string) => {
    const { orchestrator, agentId } = await bootstrapSingleAgent(agentConfigPath);
    const text = await orchestrator.dispatch(agentId, input);
    stdout.write(`\n${text}\n`);
    await orchestrator.shutdown();
  });

program
  .command("chat")
  .description("Open an interactive REPL with a single agent.")
  .argument("<agentConfig>", "path to an agent config JSON file")
  .action(async (agentConfigPath: string) => {
    const { orchestrator, agentId, name } = await bootstrapSingleAgent(agentConfigPath);
    stdout.write(`Chatting with ${name} (agent: ${agentId}). Type "exit" to quit.\n`);
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      for (;;) {
        const line = (await rl.question("\nyou › ")).trim();
        if (line === "exit" || line === "quit") break;
        if (!line) continue;
        const text = await orchestrator.dispatch(agentId, line);
        stdout.write(`\n${name} › ${text}\n`);
      }
    } finally {
      rl.close();
      await orchestrator.shutdown();
    }
  });

program
  .command("start")
  .description("Load one or more agents and start listening for inbound events.")
  .argument("<agentConfigs...>", "paths to agent config JSON files")
  .action(async (paths: string[]) => {
    const config = loadConfig();
    const log = createLogger(config.logLevel);
    const orchestrator = new Orchestrator(config, log, terminalApprover);
    for (const path of paths) {
      const cfg = await loadAgentConfig(path);
      await orchestrator.addAgent(cfg);
    }
    const stop = async () => {
      await orchestrator.shutdown();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await orchestrator.start();
  });

async function bootstrapSingleAgent(agentConfigPath: string) {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const orchestrator = new Orchestrator(config, log, terminalApprover);
  const cfg = await loadAgentConfig(agentConfigPath);
  await orchestrator.addAgent(cfg);
  return { orchestrator, agentId: cfg.id, name: cfg.persona.name };
}

program.parseAsync().catch((err: unknown) => {
  if (err instanceof ExempclawError) {
    process.stderr.write(`\n✖ ${err.message}\n`);
  } else {
    process.stderr.write(`\n✖ Unexpected error: ${(err as Error).stack ?? String(err)}\n`);
  }
  process.exit(1);
});
