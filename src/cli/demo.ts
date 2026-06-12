import { stdout } from "node:process";
import { Stage, playBanner, progressBar, flashLine } from "./tui.js";
import { liveRunHooks } from "./live.js";
import { bold, dim } from "./render.js";
import { usageLine } from "./render.js";

/**
 * `exempclaw demo` — replays a scripted agent session through the real
 * animation pipeline (the same Stage + hooks chat uses), so you can preview
 * the TUI without an API key or credentials. Also handy for testing terminal
 * compatibility.
 */
export async function runDemo(): Promise<void> {
  const stage = new Stage();
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, stage.isAnimated ? ms : 0));

  await playBanner("succession ledger · animation demo");
  stdout.write(`${dim("a scripted replay — no API calls, no credentials, nothing leaves this terminal")}\n\n`);
  stdout.write(`${bold("you ›")} Jordan, anything from Initech overnight?\n`);

  const live = liveRunHooks(stage, "Jordan");
  const h = live.hooks;

  // turn 1: the agent thinks, signals a phase, fans out two reads
  h.onTurnStart?.(1);
  await wait(1400);
  h.onStatus?.("searching", "combing the inbox for Initech traffic");
  await wait(1300);
  h.onToolStart?.("email_search", { from: "initech", sinceDays: 1 });
  h.onToolStart?.("slack_read_channel", { channel: "#initech-account" });
  await wait(1500);
  h.onToolEnd?.("email_search", true);
  await wait(500);
  h.onToolEnd?.("slack_read_channel", true);

  // turn 2: reading the thread it found
  h.onTurnStart?.(2);
  await wait(900);
  h.onStatus?.("reading", "Ana's reply about the webhook retries");
  h.onToolStart?.("email_read_message", { uid: 4711 });
  await wait(1600);
  h.onToolEnd?.("email_read_message", true);

  // turn 3: drafting + sending (outward)
  h.onTurnStart?.(3);
  await wait(800);
  h.onStatus?.("writing", "drafting a reply in Alex's voice");
  await wait(1700);
  h.onStatus?.("sending", "reply to ana.flores@initech.example");
  h.onToolStart?.("email_send", { to: ["ana.flores@initech.example"], subject: "Re: webhook retries" });
  await wait(1400);
  h.onToolEnd?.("email_send", true);

  // turn 4: the answer streams, then a small celebration
  h.onTurnStart?.(4);
  await wait(700);
  const reply =
    "One thing came in overnight: Ana confirmed the staging fix looks good and asked when it ships to prod. " +
    "I replied that we'll confirm the production date today and looped Marcus in on the renewal question. " +
    "I also noted her volume-pricing ask in memory for the September renewal.";
  for (const word of reply.split(" ")) {
    h.onText?.(`${word} `);
    await wait(26);
  }
  h.onText?.("\n");
  h.onStatus?.("celebrating", "thread handled end to end");
  await wait(1900);
  live.finish();

  stdout.write(
    `\n${usageLine({ inputTokens: 18432, outputTokens: 612, cacheReadTokens: 15210, cacheWriteTokens: 980, turns: 4 }, 0.18, 4)}\n`,
  );

  // the rest of the menagerie, for terminals and taste-testing
  stdout.write(`\n${dim("other moments you'll see around the CLI:")}\n`);
  await flashLine(`email.received ${dim("(<m4@initech>)")} → ${bold("jordan-support-lead")}`);
  stage.addRow("ingest", {
    anim: "reading",
    icon: "▥",
    label: "distilling handoff-notes.md",
    hint: `${progressBar(2, 5)} 3/5`,
  });
  await wait(1500);
  stage.settleRow("ingest", { label: "distilled archive" });
  stage.addRow("waiting", { anim: "waiting", icon: "≋", label: "waiting on IMAP IDLE" });
  await wait(1300);
  stage.removeRow("waiting");
  stage.addRow("alert", { anim: "alert", icon: "≋", label: "billing dispute over $500 — needs a human", color: "red" });
  await wait(1600);
  stage.settleRow("alert", { mark: "▲", color: "red" });
  stage.stopAll();
  stdout.write(
    `\n${dim("that's the tour — now drive it yourself, still with no API key:")} ${bold("exempclaw demo chat")}\n`,
  );
}
