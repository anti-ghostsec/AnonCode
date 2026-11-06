import { test, expect } from "bun:test";
import { generateReply } from "../src/agent/loop.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { ProviderError, type ProviderMessage } from "../src/providers/types.ts";
import { AgentLoopError } from "../src/agent/loopguard.ts";

const noSleep = async () => {};

function pngB64(w: number, h: number): string {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString("base64");
}

function imageMsg(w: number, h: number): ProviderMessage[] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: "what is in this image?" },
        { type: "image", mime: "image/png", dataB64: pngB64(w, h), filename: "fixture.png" },
      ],
    },
  ];
}

test("the 200x60 image is preflighted away, so an image-refusing model never errors", async () => {
  const provider = new MockProvider({ refuseImages: true });
  const res = await generateReply(
    provider,
    { model: "m", messages: imageMsg(200, 60) },
    { sleep: noSleep },
  );
  expect(res.text).toContain("mock-reply");
  expect(provider.callCount).toBe(1); // succeeded first try, no loop
});

test("if a model refuses an image the preflight passed, the loop strips it and retries once", async () => {
  const provider = new MockProvider({ refuseImages: true });
  // 800x600 passes preflight, so the provider actually sees the image and refuses it.
  const res = await generateReply(
    provider,
    { model: "m", messages: imageMsg(800, 600) },
    { sleep: noSleep },
  );
  expect(res.text).toContain("mock-reply");
  expect(provider.callCount).toBe(2); // refuse -> strip -> success; bounded
});

test("a provider that fails forever trips the loop guard instead of hanging", async () => {
  const provider = new MockProvider({
    alwaysFail: new ProviderError("rate_limit", "429 slow down", true),
  });
  await expect(
    generateReply(provider, { model: "m", messages: imageMsg(800, 600) }, { sleep: noSleep }),
  ).rejects.toBeInstanceOf(AgentLoopError);
  // tripped after a small, bounded number of attempts — not an infinite loop
  expect(provider.callCount).toBeLessThanOrEqual(5);
  expect(provider.callCount).toBeGreaterThanOrEqual(2);
});

test("auth errors are fatal and not retried", async () => {
  const provider = new MockProvider({
    alwaysFail: new ProviderError("auth", "401 unauthorized", false),
  });
  await expect(
    generateReply(provider, { model: "m", messages: imageMsg(800, 600) }, { sleep: noSleep }),
  ).rejects.toBeInstanceOf(ProviderError);
  expect(provider.callCount).toBe(1);
});
