import { test } from "node:test";
import assert from "node:assert/strict";
import { ANIMS, frameAt, progressBar, Stage, toolIcon, playBanner, flashLine } from "./tui.js";

function captureWriter() {
  const chunks: string[] = [];
  return {
    chunks,
    write(text: string) {
      chunks.push(text);
      return true;
    },
    get all() {
      return chunks.join("");
    },
  };
}

test("frameAt cycles frames by elapsed time", () => {
  const anim = { frames: ["a", "b", "c"], intervalMs: 100 };
  assert.equal(frameAt(anim, 0), "a");
  assert.equal(frameAt(anim, 99), "a");
  assert.equal(frameAt(anim, 100), "b");
  assert.equal(frameAt(anim, 250), "c");
  assert.equal(frameAt(anim, 300), "a"); // wraps
});

test("every animation's frames share a constant width", () => {
  for (const [name, anim] of Object.entries(ANIMS)) {
    const widths = new Set(anim.frames.map((f) => f.length));
    assert.equal(widths.size, 1, `frames of "${name}" vary in width: ${[...widths].join(",")}`);
  }
});

test("progressBar fills proportionally and clamps", () => {
  assert.equal(progressBar(0, 4, 4), "▱▱▱▱");
  assert.equal(progressBar(2, 4, 4), "▰▰▱▱");
  assert.equal(progressBar(4, 4, 4), "▰▰▰▰");
  assert.equal(progressBar(9, 4, 4), "▰▰▰▰");
  assert.equal(progressBar(1, 0, 4), "▱▱▱▱");
});

test("toolIcon maps connector families and falls back to a gear", () => {
  assert.equal(toolIcon("email_send"), "✉");
  assert.equal(toolIcon("slack_post_message"), "#");
  assert.equal(toolIcon("github_comment"), "⎇");
  assert.equal(toolIcon("notion_get_page"), "▤");
  assert.equal(toolIcon("display_status"), "≋");
  assert.equal(toolIcon("totally_custom"), "⚙");
});

test("non-TTY stage degrades to plain printed lines", () => {
  const out = captureWriter();
  const stage = new Stage({ out, tty: false });
  stage.addRow("a", { label: "working", icon: "⚙" });
  stage.updateRow("a", { label: "still working" }); // no extra output in plain mode
  stage.print("regular output\n");
  stage.settleRow("a", { mark: "✓", suffix: "done" });
  stage.stopAll();

  assert.equal(out.all.includes("\x1b["), false, "plain mode must not emit ANSI");
  assert.match(out.all, /⚙ working…\n/);
  assert.match(out.all, /regular output\n/);
  assert.match(out.all, /✓ ⚙ still working done/);
});

test("TTY stage renders rows, erases on print, and settles permanently", () => {
  const out = captureWriter();
  let nowMs = 0;
  const stage = new Stage({ out, tty: true, now: () => nowMs });
  stage.addRow("a", { label: "thinking", anim: "thinking" });
  assert.match(out.all, /thinking/);
  assert.match(out.all, /\x1b\[\?25l/, "cursor hidden while animating");

  nowMs = 1500;
  stage.write("hello ");
  // streamed text lands before the re-rendered live row
  const printed = out.all;
  assert.ok(printed.includes("hello "));
  assert.ok(printed.lastIndexOf("thinking") > printed.indexOf("hello "), "row re-rendered after text");

  stage.settleRow("a", { mark: "✓" });
  const plain = out.all.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  assert.match(plain, /✓ thinking/);
  assert.match(plain, / 1\.5s/);
  stage.stopAll();
  assert.match(out.all, /\x1b\[\?25h/, "cursor restored");
});

test("suspend clears the live region and resume redraws it", () => {
  const out = captureWriter();
  const stage = new Stage({ out, tty: true });
  stage.addRow("a", { label: "busy" });
  out.chunks.length = 0;
  stage.suspend();
  assert.match(out.all, /\x1b\[1A\x1b\[2K/, "suspend erases the row");
  out.chunks.length = 0;
  stage.resume();
  assert.match(out.all, /busy/, "resume redraws the row");
  stage.stopAll();
});

test("banner and flashLine print single plain lines off-TTY", async () => {
  const out = captureWriter();
  await playBanner("subtitle here", { out, tty: false });
  await flashLine("event line", { out, tty: false });
  assert.match(out.all, /E X E M P C L A W — subtitle here/);
  assert.match(out.all, /event line\n/);
  assert.equal(out.all.includes("\x1b["), false);
});
