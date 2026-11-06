import { test, expect } from "bun:test";
import type { Message, Role, ContentPart } from "../src/session/types.ts";
import { toProviderMessages } from "../src/agent/conversation.ts";
import { buildSpans } from "../src/context/span.ts";

let c = 0;
function m(role: Role, parts: ContentPart[]): Message {
  return { id: `m${c++}`, role, parts, createdAt: new Date(++c).toISOString() };
}

test("persisted tool_call parts render compactly; big payloads are not re-sent", () => {
  const big = "x".repeat(500);
  const msgs = [
    m("user", [{ type: "text", text: "make a file" }]),
    m("assistant", [
      { type: "text", text: "I'll create it" },
      { type: "tool_call", id: "c1", name: "write", args: { path: "a.ts", content: big } },
    ]),
    m("tool", [{ type: "tool_result", id: "t1", result: "created a.ts (500 bytes)", isError: false }]),
  ];
  const flat = toProviderMessages(msgs)
    .flatMap((p) => p.content)
    .map((x) => (x.type === "text" ? x.text : ""))
    .join("\n");
  expect(flat).toContain("[called write");
  expect(flat).toContain("[tool result] created a.ts");
  expect(flat).not.toContain(big); // the 500-char payload is not replayed verbatim
});

test("a persisted error tool_result makes its span defensive (kept by FOCUS)", () => {
  const msgs = [
    m("user", [{ type: "text", text: "go" }]),
    m("assistant", [
      { type: "text", text: "trying" },
      { type: "tool_call", id: "c", name: "bash", args: { command: "false" } },
    ]),
    m("tool", [{ type: "tool_result", id: "t", result: "exit 1: boom", isError: true }]),
  ];
  const spans = buildSpans(msgs);
  const assistantSpan = spans.find((s) => s.kind === "assistant")!;
  expect(assistantSpan.isError).toBe(true);
});
