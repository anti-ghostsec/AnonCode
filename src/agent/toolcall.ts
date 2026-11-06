/**
 * Provider-agnostic tool-call protocol.
 *
 * Rather than rely on each provider's native function-calling (which weak and
 * local models support unevenly), AnonCode uses a strict text protocol: to use
 * a tool the model emits exactly one fenced block:
 *
 *   ```tool
 *   {"tool": "edit", "args": {"path": "src/x.ts", "find": "...", "replace": "..."}}
 *   ```
 *
 * This works with any model that can follow instructions and emit a code block,
 * and it is trivial to parse and validate. The parser returns the first valid
 * tool block, or null when the message is a normal (final) reply.
 */

export type ToolCall = {
  tool: string;
  args: Record<string, unknown>;
};

const BLOCK = /```tool\s*\n([\s\S]*?)```/i;

export function parseToolCall(text: string): ToolCall | null {
  const m = BLOCK.exec(text);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]!.trim());
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as ToolCall).tool !== "string"
  ) {
    return null;
  }
  const call = parsed as ToolCall;
  return { tool: call.tool, args: (call.args ?? {}) as Record<string, unknown> };
}

/** Strip the tool block, leaving any prose the model wrote alongside it. */
export function stripToolBlock(text: string): string {
  return text.replace(BLOCK, "").trim();
}
