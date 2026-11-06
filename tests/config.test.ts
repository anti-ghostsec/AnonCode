import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/crypto/vault.ts";
import { EncryptedStore } from "../src/store/store.ts";
import { loadConfig, setProvider, resolveProvider } from "../src/config/config.ts";

const FAST = { algo: "scrypt", N: 1 << 10, r: 8, p: 1, keyLen: 32 } as const;
const dir = mkdtempSync(join(tmpdir(), "anoncode-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("provider config round-trips and resolves default", () => {
  const store = new EncryptedStore(Vault.create("pw", FAST), mkdtempSync(join(dir, "c-")));
  setProvider(store, "anthropic", { kind: "anthropic", model: "claude-x", apiKey: "sk-secret-123" });
  const cfg = loadConfig(store);
  expect(cfg.defaultProvider).toBe("anthropic");
  const r = resolveProvider(cfg);
  expect(r?.provider.model).toBe("claude-x");
  expect(r?.provider.apiKey).toBe("sk-secret-123");
});

test("the API key is sealed on disk, not stored in plaintext", () => {
  const base = mkdtempSync(join(dir, "key-"));
  const store = new EncryptedStore(Vault.create("pw", FAST), base);
  setProvider(store, "openai", { kind: "openai", model: "gpt", apiKey: "sk-PLAINTEXT-LEAK" });
  const files = readdirSync(join(base, "_config"));
  const raw = readFileSync(join(base, "_config", files[0]!), "utf8");
  expect(raw.includes("sk-PLAINTEXT-LEAK")).toBe(false);
  expect(raw.includes("apiKey")).toBe(false);
});

test("resolveProvider returns null when nothing is configured", () => {
  const store = new EncryptedStore(Vault.create("pw", FAST), mkdtempSync(join(dir, "empty-")));
  expect(resolveProvider(loadConfig(store))).toBeNull();
});
