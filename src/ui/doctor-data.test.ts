import { test } from "node:test";
import assert from "node:assert/strict";
import { doctorChecks } from "./doctor-data.js";

test("reports key presence with a fix-it hint", () => {
  const without = doctorChecks({});
  const keyCheck = without.find((c) => c.label === "ANTHROPIC_API_KEY")!;
  assert.equal(keyCheck.ok, false);
  assert.match(keyCheck.hint!, /console\.anthropic\.com/);

  const withKey = doctorChecks({ ANTHROPIC_API_KEY: "sk-ant-xxx" });
  assert.equal(withKey.find((c) => c.label === "ANTHROPIC_API_KEY")!.ok, true);
});

test("includes connector checks with missing env vars named", () => {
  const checks = doctorChecks({});
  const email = checks.find((c) => c.label === "connector: email")!;
  assert.equal(email.ok, false);
  assert.match(email.hint!, /EMAIL_USER/);
});
