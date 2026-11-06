/**
 * Provider-agnostic tool-call protocol.
 *
 * To use a tool the model emits a tool call as JSON. The canonical form is a
 * fenced block:
 *
 *   ```tool
 *   {"tool": "edit", "args": {"path": "src/x.ts", "find": "...", "replace": "..."}}
 *   ```
 *
 * but models are inconsistent, so the parser is tolerant: it also accepts a
 * ```json fence, <tool>…</tool> / <tool_call>…</tool_call> tags, and a bare
 * JSON object that has a "tool" key. The first candidate that parses to a valid
 * tool call wins; anything else is treated as a normal (final) reply.
 */

export type ToolCall = {
  tool: string;
  args: Record<string, unknown>;
};

type Match = { call: ToolCall; text: string };

// Wrappers that may hold a tool-call JSON payload. Each capture group is the
// inner JSON (possibly with surrounding prose we then brace-scan).
const WRAPPERS: RegExp[] = [
  /```(?:tool|json)?\s*\n?([\s\S]*?)```/gi, // fenced ```tool / ```json / ```
  /<tool_call>\s*([\s\S]*?)<\/tool_call>/gi, // <tool_call>…</tool_call>
  /<tool>\s*([\s\S]*?)<\/tool>/gi, // <tool>…</tool>
];

/** The first valid tool call plus the exact source text to strip, or null. */
function firstMatch(text: string): Match | null {
  if (!text) return null;
  for (const re of WRAPPERS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const call = fromObjectText(m[1] ?? "");
      if (call) return { call, text: m[0] };
    }
  }
  // Last resort: a bare {...} object anywhere that has a "tool" key.
  for (const span of braceObjects(text)) {
    const call = parseCall(span);
    if (call) return { call, text: span };
  }
  return null;
}

/** Parse the first valid tool-call object inside a candidate string. */
function fromObjectText(inner: string): ToolCall | null {
  const direct = parseCall(inner.trim());
  if (direct) return direct;
  for (const span of braceObjects(inner)) {
    const call = parseCall(span);
    if (call) return call;
  }
  return null;
}

function parseCall(jsonText: string): ToolCall | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as { tool?: unknown; name?: unknown; args?: unknown; arguments?: unknown };
  const tool = typeof obj.tool === "string" ? obj.tool : typeof obj.name === "string" ? obj.name : null;
  if (!tool) return null;
  const rawArgs = obj.args ?? obj.arguments ?? {};
  const args = typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
  return { tool, args };
}

/** Every top-level {...} substring in `text` (brace-balanced). */
function braceObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

export function parseToolCall(text: string): ToolCall | null {
  return firstMatch(text)?.call ?? null;
}

/** Strip the tool call, leaving any prose the model wrote alongside it. */
export function stripToolBlock(text: string): string {
  const m = firstMatch(text);
  if (!m) return text.trim();
  return text.replace(m.text, "").trim();
}
