import { test, expect, afterEach } from "bun:test";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import type { GenerateRequest, StreamDelta } from "../src/providers/types.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function sseResponse(lines: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close(); },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const req: GenerateRequest = { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };

test("anthropic generateStream separates thinking_delta from text_delta", async () => {
  globalThis.fetch = (async () => sseResponse([
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me think "}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"about it"}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello "}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"world"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
  ])) as unknown as typeof fetch;
  const p = new AnthropicProvider("k");
  const deltas: StreamDelta[] = [];
  const res = await p.generateStream!(req, (d) => deltas.push(d));
  expect(res.text).toBe("Hello world");
  expect(res.reasoning).toBe("let me think about it");
  expect(res.stopReason).toBe("end_turn");
  expect(deltas.filter((d) => d.type === "text").map((d) => d.text).join("")).toBe("Hello world");
  expect(deltas.some((d) => d.type === "reasoning")).toBe(true);
});

test("anthropic generateStream pulls inline <think> tags out of streamed text", async () => {
  globalThis.fetch = (async () => sseResponse([
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<think>because</think>the answer"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
  ])) as unknown as typeof fetch;
  const p = new AnthropicProvider("k");
  const res = await p.generateStream!(req, () => {});
  expect(res.text).toBe("the answer");
  expect(res.reasoning).toContain("because");
});

test("anthropic generateStream maps an error status to a ProviderError", async () => {
  globalThis.fetch = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
  const p = new AnthropicProvider("k");
  await expect(p.generateStream!(req, () => {})).rejects.toThrow();
});
