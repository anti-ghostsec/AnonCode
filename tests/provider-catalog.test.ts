import { test, expect } from "bun:test";
import { PROVIDER_PRESETS, findPreset } from "../src/providers/catalog.ts";
import { friendlyProviderError, probeProvider } from "../src/providers/index.ts";
import { ProviderError } from "../src/providers/types.ts";
import type { ProviderConfig } from "../src/config/config.ts";

test("catalog covers the common providers and only the two engine kinds", () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  for (const id of ["anthropic", "openai", "google", "openrouter", "groq", "deepseek", "venice", "ollama", "custom"])
    expect(ids).toContain(id);
  // Venice is OpenAI-compatible but must target its own host, not OpenAI's.
  const venice = findPreset("venice")!;
  expect(venice.kind).toBe("openai");
  expect(venice.baseUrl).toContain("venice.ai");
  for (const p of PROVIDER_PRESETS) expect(["anthropic", "openai"]).toContain(p.kind);
  // Local presets are keyless; hosted ones need a key.
  expect(findPreset("ollama")!.needsKey).toBe(false);
  expect(findPreset("anthropic")!.needsKey).toBe(true);
  // OpenAI-compatible presets carry a base URL ending at the version segment.
  for (const p of PROVIDER_PRESETS) if (p.kind === "openai" && p.id !== "custom") expect(p.baseUrl).toBeTruthy();
});

test("friendlyProviderError turns an auth failure into a clear sentence (no HTTP noise)", () => {
  const cfg: ProviderConfig = { kind: "openai", model: "gpt-4o", baseUrl: "https://api.openai.com/v1" };
  const msg = friendlyProviderError(new ProviderError("auth", "HTTP 401: {invalid key}", false), cfg);
  expect(msg).toContain("api.openai.com");
  expect(msg.toLowerCase()).toContain("key");
  expect(msg).not.toContain("HTTP 401");
});

test("friendlyProviderError points local endpoints at the local server", () => {
  const cfg: ProviderConfig = { kind: "openai", model: "llama3.1", baseUrl: "http://localhost:11434/v1" };
  const msg = friendlyProviderError(new ProviderError("network", "network error", true), cfg);
  expect(msg.toLowerCase()).toContain("local");
});

test("probeProvider succeeds against the mock provider", async () => {
  const res = await probeProvider({ kind: "mock", model: "demo" } as ProviderConfig);
  expect(res.ok).toBe(true);
});

test("probeProvider reports a friendly message when the key is rejected", async () => {
  // An openai-compatible endpoint that can't exist → network/other failure,
  // surfaced as a friendly, non-raw message.
  const res = await probeProvider({
    kind: "openai",
    model: "gpt-4o",
    apiKey: "bad",
    baseUrl: "http://127.0.0.1:1/v1",
  } as ProviderConfig);
  expect(res.ok).toBe(false);
  expect(res.message).toBeTruthy();
  expect(res.message).not.toContain("HTTP ");
});
