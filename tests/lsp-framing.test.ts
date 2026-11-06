import { test, expect } from "bun:test";
import { encodeMessage, MessageReader } from "../src/lsp/framing.ts";

test("encode then decode round-trips", () => {
  const reader = new MessageReader();
  const got: unknown[] = [];
  reader.push(encodeMessage({ jsonrpc: "2.0", id: 1, method: "x" }), (m) => got.push(m));
  expect(got).toEqual([{ jsonrpc: "2.0", id: 1, method: "x" }]);
});

test("handles a message split across chunks", () => {
  const reader = new MessageReader();
  const buf = encodeMessage({ hello: "world" });
  const got: unknown[] = [];
  reader.push(buf.subarray(0, 10), (m) => got.push(m));
  expect(got.length).toBe(0); // incomplete
  reader.push(buf.subarray(10), (m) => got.push(m));
  expect(got).toEqual([{ hello: "world" }]);
});

test("handles multiple messages in one chunk", () => {
  const reader = new MessageReader();
  const buf = Buffer.concat([encodeMessage({ a: 1 }), encodeMessage({ b: 2 })]);
  const got: unknown[] = [];
  reader.push(buf, (m) => got.push(m));
  expect(got).toEqual([{ a: 1 }, { b: 2 }]);
});
