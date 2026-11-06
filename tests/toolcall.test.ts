import { test, expect } from "bun:test";
import { parseToolCall, stripToolBlock } from "../src/agent/toolcall.ts";

test("parses the canonical fenced ```tool block", () => {
  expect(parseToolCall('```tool\n{"tool":"ls","args":{}}\n```')).toEqual({ tool: "ls", args: {} });
});

test("parses a ```json fence and a bare ``` fence", () => {
  expect(parseToolCall('```json\n{"tool":"read","args":{"path":"a.txt"}}\n```')).toEqual({ tool: "read", args: { path: "a.txt" } });
  expect(parseToolCall('```\n{"tool":"ls","args":{}}\n```')).toEqual({ tool: "ls", args: {} });
});

test("parses <tool> and <tool_call> tag forms (the bug: read was emitted this way)", () => {
  expect(parseToolCall('<tool>\n{"tool":"read","args":{"path":"inside.txt"}}\n</tool>')).toEqual({ tool: "read", args: { path: "inside.txt" } });
  expect(parseToolCall('<tool_call>{"tool":"ls","args":{}}</tool_call>')).toEqual({ tool: "ls", args: {} });
});

test("parses a bare JSON object with a tool key, and tolerates `name`/`arguments`", () => {
  expect(parseToolCall('let me look: {"tool":"ls","args":{}} ok')).toEqual({ tool: "ls", args: {} });
  expect(parseToolCall('{"name":"read","arguments":{"path":"x"}}')).toEqual({ tool: "read", args: { path: "x" } });
});

test("a normal reply with no tool call returns null", () => {
  expect(parseToolCall("Here is the answer. No tools needed.")).toBeNull();
  expect(parseToolCall("")).toBeNull();
});

test("stripToolBlock removes the matched call and keeps surrounding prose", () => {
  expect(stripToolBlock('Let me look.\n```tool\n{"tool":"ls","args":{}}\n```')).toBe("Let me look.");
  expect(stripToolBlock('reading now <tool>{"tool":"read","args":{"path":"a"}}</tool>')).toBe("reading now");
  expect(stripToolBlock("just prose")).toBe("just prose");
});

test("strings containing braces don't break the bare-object scan", () => {
  expect(parseToolCall('{"tool":"write","args":{"content":"a } b { c"}}')).toEqual({ tool: "write", args: { content: "a } b { c" } });
});
