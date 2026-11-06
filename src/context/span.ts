import type { Message } from "../session/types.ts";

/**
 * FOCUS operates on *spans*, not raw tokens. Following the paper
 * (arXiv:2609.37590), each span is a (reasoning, action, observation) unit kept
 * intact — so tool calls, their results, and errors are never split. In
 * AnonCode a span is:
 *   - a user message (the first one is the task goal),
 *   - an assistant message together with any tool results it produced, or
 *   - a system message.
 */

export type SpanKind = "user_goal" | "user" | "assistant" | "tool_result" | "system";

export type Span = {
  id: string;
  kind: SpanKind;
  /** The actual messages this span covers, kept verbatim for reconstruction. */
  messages: Message[];
  messageIds: string[];
  /** Flattened text, used for scoring and token estimation. */
  text: string;
  /** True if the span records a failure/error/rejection (defensive pass keeps these). */
  isError: boolean;
  tokens: number;
  index: number;
};

/** Cheap, model-agnostic token estimate (~4 chars/token). Override for real counts. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function partsText(m: Message): string {
  const out: string[] = [];
  for (const p of m.parts) {
    if (p.type === "text") out.push(p.text);
    else if (p.type === "image") out.push(`[image ${p.filename ?? p.mime}]`);
    else if (p.type === "tool_call") out.push(`[tool_call ${p.name} ${JSON.stringify(p.args)}]`);
    else if (p.type === "tool_result") out.push(p.result);
  }
  return out.join("\n");
}

function msgIsError(m: Message): boolean {
  return m.parts.some((p) => p.type === "tool_result" && p.isError === true);
}

export function buildSpans(messages: Message[], estimate = estimateTokens): Span[] {
  const spans: Span[] = [];
  let seenUser = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "assistant") {
      const group = [m];
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === "tool") {
        group.push(messages[j]!);
        j++;
      }
      spans.push(mk(group, "assistant", group.some(msgIsError), spans.length, estimate));
      i = j - 1;
    } else if (m.role === "user") {
      spans.push(mk([m], seenUser ? "user" : "user_goal", false, spans.length, estimate));
      seenUser = true;
    } else if (m.role === "system") {
      spans.push(mk([m], "system", false, spans.length, estimate));
    } else {
      spans.push(mk([m], "tool_result", msgIsError(m), spans.length, estimate));
    }
  }
  return spans;
}

function mk(
  group: Message[],
  kind: SpanKind,
  isError: boolean,
  index: number,
  estimate: (s: string) => number,
): Span {
  const text = group.map(partsText).join("\n");
  return {
    id: group[0]!.id,
    kind,
    messages: group,
    messageIds: group.map((g) => g.id),
    text,
    isError,
    tokens: estimate(text),
    index,
  };
}
