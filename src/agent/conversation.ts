import type { Message } from "../session/types.ts";
import type { ProviderMessage, ProviderContent } from "../providers/types.ts";

export const DEFAULT_SYSTEM_PROMPT =
  "You are AnonCode, a private coding assistant. Be concise and direct. " +
  "All of this conversation is stored encrypted on the user's machine.";

/**
 * Convert stored session messages into the provider's message shape. Tool
 * parts are flattened to text for now (the tool system is a later phase);
 * images are carried through for the preflight to handle.
 */
export function toProviderMessages(messages: Message[]): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const text = m.parts
        .map((p) => (p.type === "tool_result" ? p.result : ""))
        .filter(Boolean)
        .join("\n");
      if (text) out.push({ role: "user", content: [{ type: "text", text: `[tool result] ${text}` }] });
      continue;
    }
    if (m.role === "system") continue; // system handled separately
    const content: ProviderContent[] = [];
    for (const p of m.parts) {
      if (p.type === "text") {
        if (p.text) content.push({ type: "text", text: p.text });
      } else if (p.type === "reasoning") {
        // Stored for display/restore only; never resent to the model as input.
        continue;
      } else if (p.type === "image") {
        content.push({ type: "image", mime: p.mime, dataB64: p.dataB64, filename: p.filename });
      } else if (p.type === "tool_call") {
        // Compact record of the action — not the full tool payload — so prior
        // large writes/edits aren't re-sent verbatim every turn.
        const args = JSON.stringify(p.args ?? {});
        content.push({ type: "text", text: `[called ${p.name} ${args.length > 160 ? args.slice(0, 160) + "…" : args}]` });
      }
    }
    if (content.length > 0) out.push({ role: m.role === "assistant" ? "assistant" : "user", content });
  }
  return out;
}
