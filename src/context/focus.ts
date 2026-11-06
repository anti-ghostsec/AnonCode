import type { Span } from "./span.ts";
import type { DraftModel } from "./draft.ts";

/**
 * FOCUS — Training-Free Decision-Preserving Context Compression
 * (arXiv:2609.37590), adapted to AnonCode.
 *
 * Algorithm:
 *   1. If total history <= memory budget, keep everything (no compression).
 *   2. Run N draft-model rollouts; each cites the spans it depends on. The
 *      citation frequency u_hat(span) in [0,1] is the dependency score.
 *   3. Utility retention: keep spans with u_hat >= tau.
 *   4. Defensive pass: additionally keep spans whose loss would cause repeated
 *      mistakes or lost state — errors/failures, EVERY user message (the task
 *      goal and all later instructions — they can't be reconstructed), system
 *      spans, and the most recent spans.
 *   5. Keep S_U ∪ S_defensive verbatim; drop the rest. Summarize nothing.
 *   6. (AnonCode extra) Optional hard cap: if still over a ceiling, drop the
 *      lowest-utility NON-protected spans until it fits.
 *
 * Every decision is recorded in the report for auditing when the agent fails.
 */

export type FocusOptions = {
  /** Trigger threshold (delta_mem). Below this, no compression happens. */
  memoryBudgetTokens: number;
  /** Utility threshold tau in [0,1]. */
  tau: number;
  /** Number of Monte Carlo rollouts N. */
  rollouts: number;
  /** Always keep this many most-recent spans (current state). */
  keepRecent: number;
  /** Optional ceiling; drop lowest-utility non-protected spans to fit under it. */
  hardCapTokens?: number;
};

export const DEFAULT_FOCUS_OPTIONS: FocusOptions = {
  memoryBudgetTokens: 8000,
  tau: 0.3,
  rollouts: 3,
  keepRecent: 3,
};

export type SpanDecision = {
  id: string;
  kind: string;
  index: number;
  tokens: number;
  score: number;
  kept: boolean;
  protectedSpan: boolean;
  reasons: string[];
};

export type CompressionReport = {
  triggered: boolean;
  totalTokens: number;
  keptTokens: number;
  keptCount: number;
  droppedCount: number;
  decisions: SpanDecision[];
};

export async function focusCompress(
  spans: Span[],
  draft: DraftModel,
  task: string,
  options: Partial<FocusOptions> = {},
): Promise<{ kept: Span[]; report: CompressionReport }> {
  const opts = { ...DEFAULT_FOCUS_OPTIONS, ...options };
  const totalTokens = spans.reduce((a, s) => a + s.tokens, 0);

  if (totalTokens <= opts.memoryBudgetTokens) {
    return {
      kept: spans,
      report: {
        triggered: false,
        totalTokens,
        keptTokens: totalTokens,
        keptCount: spans.length,
        droppedCount: 0,
        decisions: spans.map((s) => ({
          id: s.id, kind: s.kind, index: s.index, tokens: s.tokens,
          score: 1, kept: true, protectedSpan: true, reasons: ["under memory budget"],
        })),
      },
    };
  }

  // Monte Carlo rollouts -> citation frequency.
  const counts = new Map<string, number>();
  for (let k = 0; k < opts.rollouts; k++) {
    const cited = await draft.citedSpans(spans, task);
    for (const id of cited) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const uHat = (id: string) => (counts.get(id) ?? 0) / Math.max(1, opts.rollouts);

  const recentStart = Math.max(0, spans.length - opts.keepRecent);
  const decisions: SpanDecision[] = spans.map((s, i) => {
    const score = uHat(s.id);
    const reasons: string[] = [];
    let protectedSpan = false;
    if (s.isError) { protectedSpan = true; reasons.push("defensive: error/failure"); }
    // Every user message is a non-reconstructable instruction, not just the
    // first — losing any of them makes the agent act against a goal it can no
    // longer see. They are cheap next to tool output, so always keep them.
    if (s.kind === "user_goal") { protectedSpan = true; reasons.push("defensive: task goal"); }
    if (s.kind === "user") { protectedSpan = true; reasons.push("defensive: user instruction"); }
    if (s.kind === "system") { protectedSpan = true; reasons.push("defensive: system"); }
    if (i >= recentStart) { protectedSpan = true; reasons.push("defensive: recent state"); }

    let kept = protectedSpan;
    if (score >= opts.tau) {
      kept = true;
      reasons.push(`utility ${score.toFixed(2)} >= tau ${opts.tau}`);
    } else {
      reasons.push(`utility ${score.toFixed(2)} < tau ${opts.tau}`);
    }
    return { id: s.id, kind: s.kind, index: s.index, tokens: s.tokens, score, kept, protectedSpan, reasons };
  });

  // Optional hard cap.
  if (opts.hardCapTokens !== undefined) {
    let keptTokens = decisions.filter((d) => d.kept).reduce((a, d) => a + d.tokens, 0);
    const droppable = decisions
      .filter((d) => d.kept && !d.protectedSpan)
      .sort((a, b) => a.score - b.score || a.index - b.index);
    for (const d of droppable) {
      if (keptTokens <= opts.hardCapTokens) break;
      d.kept = false;
      d.reasons.push("dropped: over hard cap");
      keptTokens -= d.tokens;
    }
  }

  const keptIds = new Set(decisions.filter((d) => d.kept).map((d) => d.id));
  const kept = spans.filter((s) => keptIds.has(s.id));
  const keptTokens = kept.reduce((a, s) => a + s.tokens, 0);

  return {
    kept,
    report: {
      triggered: true,
      totalTokens,
      keptTokens,
      keptCount: kept.length,
      droppedCount: spans.length - kept.length,
      decisions,
    },
  };
}
