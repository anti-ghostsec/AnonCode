import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerifier, verifierFeedback } from "../src/agent/verifier.ts";

const tmp = mkdtempSync(join(tmpdir(), "anoncode-verify-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("runVerifier reports success for a passing command", async () => {
  const r = await runVerifier("exit 0", tmp);
  expect(r.ok).toBe(true);
  expect(r.output).toContain("exit 0");
});

test("runVerifier reports failure and captures output", async () => {
  const r = await runVerifier("echo boom && exit 1", tmp);
  expect(r.ok).toBe(false);
  expect(r.output).toContain("boom");
  expect(r.output).toContain("exit 1");
});

test("runVerifier flags a command that can't run (the `idk` case)", async () => {
  // Use a name that cannot exist on PATH (the literal `idk` may have been left
  // behind as a stub by the very bug this guards against).
  const r = await runVerifier("anoncode_no_such_cmd_" + Date.now(), tmp);
  expect(r.ok).toBe(false);
  expect(r.couldNotRun).toBe(true); // exit 127 / command not found
});

test("a real failing command is not flagged as couldNotRun", async () => {
  const r = await runVerifier("exit 1", tmp);
  expect(r.ok).toBe(false);
  expect(r.couldNotRun).toBe(false);
});

test("verifierFeedback asks the worker to fix the code and forbids gaming the check", () => {
  const fb = verifierFeedback("bun test", "3 fail");
  expect(fb).toContain("bun test");
  expect(fb).toContain("3 fail");
  expect(fb.toLowerCase()).toContain("fix");
  // Must explicitly forbid faking/stubbing the check (the idk-stub failure).
  expect(fb.toLowerCase()).toMatch(/do not|don.t/);
  expect(fb.toLowerCase()).toContain("stub");
});

test("verifierFeedback truncates very long output", () => {
  const fb = verifierFeedback("bun test", "x".repeat(10000));
  expect(fb).toContain("truncated");
  expect(fb.length).toBeLessThan(6000);
});
