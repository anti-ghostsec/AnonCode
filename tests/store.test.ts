import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/crypto/vault.ts";
import { EncryptedStore, newId } from "../src/store/store.ts";

const FAST = { algo: "scrypt", N: 1 << 10, r: 8, p: 1, keyLen: 32 } as const;
const dir = mkdtempSync(join(tmpdir(), "anoncode-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("putJSON/getJSON round-trips and persists encrypted", () => {
  const v = Vault.create("pw", FAST);
  const store = new EncryptedStore(v, dir);
  const id = newId("sess");
  const msg = { role: "user", text: "where are my private keys stored?" };
  store.putJSON("messages", id, msg);
  expect(store.getJSON("messages", id)).toEqual(msg);

  // On-disk bytes must be ciphertext, not the plaintext content.
  const files = readdirSync(join(dir, "messages"));
  expect(files.length).toBe(1);
  const raw = readFileSync(join(dir, "messages", files[0]!), "utf8");
  expect(raw.includes("private keys")).toBe(false);
  expect(raw.includes("user")).toBe(false);
});

test("list returns ids in chronological order", async () => {
  const v = Vault.create("pw", FAST);
  const store = new EncryptedStore(v, join(dir, "ordered"));
  const a = newId();
  await Bun.sleep(2);
  const b = newId();
  store.putJSON("c", b, { n: 2 });
  store.putJSON("c", a, { n: 1 });
  expect(store.list("c")).toEqual([a, b].sort());
});

test("rejects unsafe collection/id names (path traversal)", () => {
  const v = Vault.create("pw", FAST);
  const store = new EncryptedStore(v, dir);
  expect(() => store.putJSON("../escape", "x", {})).toThrow();
  expect(() => store.putJSON("messages", "../../etc/passwd", {})).toThrow();
});

test("missing records return null", () => {
  const v = Vault.create("pw", FAST);
  const store = new EncryptedStore(v, dir);
  expect(store.getJSON("messages", newId())).toBeNull();
});
