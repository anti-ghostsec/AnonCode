import { test, expect } from "bun:test";
import type { Message, Role, ContentPart } from "../src/session/types.ts";
import { buildSpans } from "../src/context/span.ts";
import { focusCompress, type FocusOptions } from "../src/context/focus.ts";
import { parseDependsOn, HeuristicDraftModel, type DraftModel } from "../src/context/draft.ts";
import { compressHistory } from "../src/context/index.ts";

let counter = 0;
function msg(role: Role, text: string, opts: { error?: boolean } = {}): Message {
  const parts: ContentPart[] =
    role === "tool"
      ? [{ type: "tool_result", id: "t", result: text, isError: opts.error }]
      : [{ type: "text", text }];
  return { id: `m${counter++}`, role, parts, createdAt: new Date(counter).toISOString() };
}

/** Draft that cites a fixed set of ids every rollout (full control in tests). */
class FixedDraft implements DraftModel {
  constructor(private ids: string[]) {}
  async citedSpans(): Promise<string[]> {
    return this.ids;
  }
}
/** Draft that returns a different set per rollout (to vary citation frequency). */
class SequenceDraft implements DraftModel {
  private i = 0;
  constructor(private seq: string[][]) {}
  async citedSpans(): Promise<string[]> {
    return this.seq[Math.min(this.i++, this.seq.length - 1)]!;
  }
}

const tiny: Partial<FocusOptions> = { memoryBudgetTokens: 1, tau: 0.5, rollouts: 1, keepRecent: 1 };

test("buildSpans groups assistant+tool and marks the first user as the goal", () => {
  const msgs = [
    msg("user", "deploy the service"),
    msg("assistant", "I'll run the deploy"),
    msg("tool", "deploy ok"),
    msg("user", "now run tests"),
  ];
  const spans = buildSpans(msgs);
  expect(spans.map((s) => s.kind)).toEqual(["user_goal", "assistant", "user"]);
  expect(spans[1]!.messages.length).toBe(2); // assistant + tool result folded together
});

test("under the memory budget nothing is compressed", async () => {
  const spans = buildSpans([msg("user", "hi"), msg("assistant", "hello")]);
  const { kept, report } = await focusCompress(spans, new FixedDraft([]), "hi", {
    memoryBudgetTokens: 100000,
  });
  expect(report.triggered).toBe(false);
  expect(kept.length).toBe(spans.length);
});

test("low-utility spans are dropped; goal, error, recent, and cited spans survive", async () => {
  const goal = msg("user", "fix the login bug");
  const filler = msg("assistant", "here is some unrelated commentary about the weather");
  const cited = msg("assistant", "the login handler validates the session token");
  const errored = msg("tool", "TypeError: cannot read session", { error: true });
  const recent = msg("user", "what next?");
  const spans = buildSpans([goal, filler, cited, errored, recent]);

  const { kept, report } = await focusCompress(spans, new FixedDraft([cited.id]), "fix login", tiny);

  expect(report.triggered).toBe(true);
  // check at the message level, since an assistant+tool pair folds into one span
  const keptMsgs = new Set(kept.flatMap((s) => s.messageIds));
  expect(keptMsgs.has(goal.id)).toBe(true); // defensive: goal
  expect(keptMsgs.has(cited.id)).toBe(true); // utility
  expect(keptMsgs.has(errored.id)).toBe(true); // defensive: error (folded into cited span)
  expect(keptMsgs.has(recent.id)).toBe(true); // defensive: recent
  expect(keptMsgs.has(filler.id)).toBe(false); // dropped
});

test("a mid-history user instruction is never dropped (regression: the forgotten 2nd message)", async () => {
  // Reproduces the live bug: the user's 2nd message sat mid-history, wasn't in
  // the recent window, and the draft cited nothing — FOCUS was evicting it, so
  // the agent acted against instructions it could no longer see.
  const goal = msg("user", "you there?");
  const a1 = msg("assistant", "yes — let me get started on something generic");
  const instruction = msg("user", "scan the literature on training-free KV-cache compression and summarize the top 3");
  const a2 = msg("assistant", "lots of unrelated tool chatter and output here");
  const filler = msg("assistant", "yet more unrelated commentary to pad the history out");
  const recent = msg("user", "continue, were you cut off?");
  const spans = buildSpans([goal, a1, instruction, a2, filler, recent]);

  // Draft cites nothing; keepRecent=1 so only `recent` is recency-protected.
  const { kept } = await focusCompress(spans, new FixedDraft([]), "continue", {
    memoryBudgetTokens: 1, tau: 0.9, rollouts: 1, keepRecent: 1,
  });
  const keptMsgs = new Set(kept.flatMap((s) => s.messageIds));
  expect(keptMsgs.has(goal.id)).toBe(true); // first user message (task goal)
  expect(keptMsgs.has(instruction.id)).toBe(true); // the 2nd user message MUST survive
  expect(keptMsgs.has(recent.id)).toBe(true); // recent
  // non-user, uncited, non-recent spans may still be dropped
  expect(keptMsgs.has(filler.id)).toBe(false);
});

test("an uncited error span is still rescued by the defensive pass", async () => {
  const goal = msg("user", "build it");
  const a = msg("assistant", "working on it");
  const err = msg("tool", "compile failed: missing semicolon", { error: true });
  const spans = buildSpans([goal, a, err]);
  // draft cites nothing at all
  const { kept } = await focusCompress(spans, new FixedDraft([]), "build", {
    ...tiny,
    keepRecent: 0,
  });
  const keptMsgs = new Set(kept.flatMap((s) => s.messageIds));
  expect(keptMsgs.has(err.id)).toBe(true); // error span rescued despite no citation
});

test("the hard cap drops the lowest-utility non-protected span", async () => {
  const goal = msg("user", "task");
  const hi = msg("assistant", "high utility span aaaaaaaaaaaaaaaaaaaa");
  const lo = msg("assistant", "low utility span bbbbbbbbbbbbbbbbbbbb");
  const spans = buildSpans([goal, hi, lo]);
  const [gs, his] = spans; // goal span, hi span
  // hi cited twice, lo once over 2 rollouts -> u_hat(hi)=1.0, u_hat(lo)=0.5
  const draft = new SequenceDraft([[hi.id, lo.id], [hi.id]]);
  const { kept } = await focusCompress(spans, draft, "task", {
    memoryBudgetTokens: 1,
    tau: 0.4,
    rollouts: 2,
    keepRecent: 0,
    hardCapTokens: gs!.tokens + his!.tokens, // only room for goal + one more span
  });
  const ids = new Set(kept.map((s) => s.id));
  expect(ids.has(goal.id)).toBe(true); // protected
  expect(ids.has(hi.id)).toBe(true); // higher utility retained
  expect(ids.has(lo.id)).toBe(false); // lower utility dropped to fit cap
});

test("parseDependsOn extracts only valid cited ids", () => {
  const valid = new Set(["m2", "m5", "m9"]);
  const plan = "Step: build | Depends on: [m2, m5]\nStep: test | Depends on: [m5, mX]";
  expect(parseDependsOn(plan, valid).sort()).toEqual(["m2", "m5"]);
});

test("compressHistory returns kept messages verbatim and in order", async () => {
  const goal = msg("user", "the task statement");
  const drop = msg("assistant", "irrelevant chatter");
  const keepLine = "the important detail to remember";
  const keep = msg("assistant", keepLine);
  const recent = msg("user", "continue");
  const { messages, report } = await compressHistory(
    [goal, drop, keep, recent],
    new HeuristicDraftModel(),
    "the task statement important detail",
    tiny,
  );
  expect(report.triggered).toBe(true);
  // kept messages preserve exact text (verbatim, no summarization)
  const texts = messages.map((m) => (m.parts[0]!.type === "text" ? m.parts[0]!.text : ""));
  expect(texts).toContain(keepLine);
  // order preserved: indices ascending
  const order = messages.map((m) => Number(m.id.slice(1)));
  expect([...order]).toEqual([...order].sort((a, b) => a - b));
});
