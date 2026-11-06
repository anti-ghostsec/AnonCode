import type { Message } from "../session/types.ts";
import { buildSpans } from "./span.ts";
import { focusCompress, type FocusOptions, type CompressionReport } from "./focus.ts";
import type { DraftModel } from "./draft.ts";

/**
 * Compress a conversation's message history with FOCUS, returning the kept
 * messages (verbatim, in order) ready to send to a provider, plus the audit
 * report. A no-op when the history is under the memory budget.
 */
export async function compressHistory(
  messages: Message[],
  draft: DraftModel,
  task: string,
  options?: Partial<FocusOptions>,
): Promise<{ messages: Message[]; report: CompressionReport }> {
  const spans = buildSpans(messages);
  const { kept, report } = await focusCompress(spans, draft, task, options);
  return { messages: kept.flatMap((s) => s.messages), report };
}

export * from "./span.ts";
export * from "./draft.ts";
export * from "./focus.ts";
