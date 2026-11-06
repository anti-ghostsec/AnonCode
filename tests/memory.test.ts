import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/crypto/vault.ts";
import { EncryptedStore } from "../src/store/store.ts";
import { MemoryStore } from "../src/agent/memory.ts";
import { buildAgentPrompt } from "../src/agent/prompt.ts";
import { MemoryFS } from "../src/vfs/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

const FAST = { algo: "scrypt", N: 1 << 10, r: 8, p: 1, keyLen: 32 } as const;
const tmp = mkdtempSync(join(tmpdir(), "anoncode-mem-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function mem(): MemoryStore {
  const dir = mkdtempSync(join(tmp, "store-"));
  return new MemoryStore(new EncryptedStore(Vault.create("pw", FAST), dir));
}

test("add stores a lesson and skips exact duplicates", () => {
  const m = mem();
  expect(m.add("always read a file before editing it")).not.toBeNull();
  expect(m.add("always read a file before editing it")).toBeNull(); // dup
  expect(m.add("  ALWAYS read a file before editing it  ")).toBeNull(); // normalized dup
  expect(m.list().length).toBe(1);
});

test("relevant ranks lessons by keyword overlap with the query", () => {
  const m = mem();
  m.add("the auth module uses bcrypt for password hashing");
  m.add("database migrations live in the migrations folder");
  m.add("run the linter before committing frontend changes");
  for (let i = 0; i < 5; i++) m.add("filler lesson number " + i);
  const hits = m.relevant("how does password auth work", 3);
  expect(hits.some((h) => h.text.includes("bcrypt"))).toBe(true);
});

test("remove and clear work", () => {
  const m = mem();
  const a = m.add("lesson a")!;
  m.add("lesson b");
  m.remove(a.id);
  expect(m.list().length).toBe(1);
  m.clear();
  expect(m.list().length).toBe(0);
});

test("buildAgentPrompt injects lessons into the system prompt", () => {
  const prompt = buildAgentPrompt({
    fs: new MemoryFS(),
    registry: new ToolRegistry(),
    mode: "build",
    memories: ["prefer the tolerant edit matcher over rewriting whole files"],
  });
  expect(prompt).toContain("Lessons learned");
  expect(prompt).toContain("tolerant edit matcher");
});

test("buildAgentPrompt omits the lessons block when there are none", () => {
  const prompt = buildAgentPrompt({ fs: new MemoryFS(), registry: new ToolRegistry(), mode: "build" });
  expect(prompt).not.toContain("Lessons learned");
});
