import { test, expect } from "bun:test";
import {
  LoopGuard,
  AgentLoopError,
  errorSignature,
} from "../src/agent/loopguard.ts";

const opts = { maxSteps: 50, maxRepeatedErrors: 3, maxRepeatedStalls: 4 };

test("trips on max steps", () => {
  const g = new LoopGuard({ ...opts, maxSteps: 3 });
  g.beginStep();
  g.beginStep();
  g.beginStep();
  expect(() => g.beginStep()).toThrow(AgentLoopError);
});

test("trips when the same error recurs (the refused-image loop)", () => {
  const g = new LoopGuard(opts);
  const sig = errorSignature({ provider: "anthropic", kind: "image_too_small", contentHash: "abc" });
  g.beginStep();
  g.recordError(sig);
  g.beginStep();
  g.recordError(sig);
  g.beginStep();
  expect(() => g.recordError(sig)).toThrow(AgentLoopError);
});

test("a different error resets the error streak", () => {
  const g = new LoopGuard(opts);
  g.beginStep();
  g.recordError("A");
  g.beginStep();
  g.recordError("A");
  g.beginStep();
  g.recordError("B"); // breaks the streak
  g.beginStep();
  expect(() => g.recordError("A")).not.toThrow();
});

test("progress resets the error streak", () => {
  const g = new LoopGuard(opts);
  g.beginStep();
  g.recordError("A");
  g.beginStep();
  g.recordError("A");
  g.beginStep();
  g.recordProgress("made-edit-1");
  g.beginStep();
  expect(() => g.recordError("A")).not.toThrow();
});

test("trips on a repeated no-progress stall", () => {
  const g = new LoopGuard(opts);
  for (let i = 0; i < 3; i++) {
    g.beginStep();
    g.recordProgress("same-action");
  }
  g.beginStep();
  expect(() => g.recordProgress("same-action")).toThrow(AgentLoopError);
});

test("real progress never trips the stall guard", () => {
  const g = new LoopGuard(opts);
  for (let i = 0; i < 20; i++) {
    g.beginStep();
    g.recordProgress(`action-${i}`);
  }
  expect(g.stepCount).toBe(20);
});

test("AgentLoopError carries a machine-readable reason", () => {
  const g = new LoopGuard({ ...opts, maxSteps: 1 });
  g.beginStep();
  try {
    g.beginStep();
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(AgentLoopError);
    expect((e as AgentLoopError).reason).toBe("max-steps");
  }
});
