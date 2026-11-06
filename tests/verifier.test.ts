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

test("verifierFeedback asks the worker to fix and includes the command + output", () => {
  const fb = verifierFeedback("bun test", "3 fail");
  expect(fb).toContain("bun test");
  expect(fb).toContain("3 fail");
  expect(fb.toLowerCase()).toContain("fix");
});

test("verifierFeedback truncates very long output", () => {
  const fb = verifierFeedback("bun test", "x".repeat(10000));
  expect(fb).toContain("truncated");
  expect(fb.length).toBeLessThan(6000);
});
