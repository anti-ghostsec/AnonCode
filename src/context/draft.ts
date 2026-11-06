import type { Span } from "./span.ts";
import type { Provider } from "../providers/types.ts";

/**
 * A draft model produces, for one Monte Carlo rollout, the set of span ids a
 * plan to continue the task would depend on. FOCUS runs several rollouts and
 * keeps spans cited often enough (citation frequency >= tau).
 *
 * Two implementations:
 *   - HeuristicDraftModel: no LLM, fully offline. Approximates dependency by
 *     lexical overlap with the task + recency + error salience. Deterministic,
 *     so it is the safe default for a privacy tool that must run without extra
 *     model calls.
 *   - ModelDraftModel: the faithful method — a cheap LLM samples a plan that
 *     cites span ids; citations across rollouts give the frequency score.
 */
export interface DraftModel {
  citedSpans(spans: Span[], task: string): Promise<string[]>;
}

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you",
  "are", "was", "but", "not", "has", "have", "will", "can", "its", "a", "an",
  "to", "of", "in", "on", "is", "be", "as", "at", "or", "if", "it", "we",
]);

function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []) {
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

export class HeuristicDraftModel implements DraftModel {
  constructor(private readonly ratio = 0.5) {}

  async citedSpans(spans: Span[], task: string): Promise<string[]> {
    if (spans.length === 0) return [];
    const taskWords = keywords(task);
    const scored = spans.map((s) => {
      const sw = keywords(s.text);
      let overlap = 0;
      for (const w of sw) if (taskWords.has(w)) overlap++;
      const recency = spans.length <= 1 ? 1 : s.index / (spans.length - 1);
      const score = overlap * 2 + recency + (s.isError ? 1 : 0);
      return { id: s.id, score, overlap };
    });
    const byScore = [...scored].sort((a, b) => b.score - a.score);
    const topK = Math.max(1, Math.ceil(spans.length * this.ratio));
    const cited = new Set<string>();
    for (let i = 0; i < topK && i < byScore.length; i++) cited.add(byScore[i]!.id);
    for (const s of scored) if (s.overlap > 0) cited.add(s.id);
    return [...cited];
  }
}

export class ModelDraftModel implements DraftModel {
  constructor(
    private readonly provider: Provider,
    private readonly model: string,
    private readonly maxTokens = 400,
  ) {}

  async citedSpans(spans: Span[], task: string): Promise<string[]> {
    const index = spans
      .map((s) => `id=${s.id} [${s.kind}] ${truncate(s.text, 200)}`)
      .join("\n");
    const prompt =
      "You are planning the next actions for a coding task.\n" +
      `Task: ${task}\n\n` +
      `History spans:\n${index}\n\n` +
      "Sketch the steps you would take next. For each step output one line:\n" +
      "Step: <what you'd do> | Depends on: [<span ids you actually need>]\n" +
      "Cite a span id only if that step truly requires it.";
    const res = await this.provider.generate({
      model: this.model,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      maxTokens: this.maxTokens,
    });
    return parseDependsOn(res.text, new Set(spans.map((s) => s.id)));
  }
}

/** Extract cited span ids from a draft plan. Reads `Depends on: [...]` lists
 * and also any valid id mentioned verbatim. */
export function parseDependsOn(text: string, valid: Set<string>): string[] {
  const cited = new Set<string>();
  const re = /depends on:\s*\[([^\]]*)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    for (const tok of m[1]!.split(/[,\s]+/)) {
      const id = tok.trim();
      if (id && valid.has(id)) cited.add(id);
    }
  }
  return [...cited];
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
