import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/crypto/vault.ts";
import { EncryptedStore } from "../src/store/store.ts";
import { SessionStore } from "../src/session/store.ts";

const FAST = { algo: "scrypt", N: 1 << 10, r: 8, p: 1, keyLen: 32 } as const;
const dir = mkdtempSync(join(tmpdir(), "anoncode-session-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function freshStore() {
  const v = Vault.create("pw", FAST);
  return new EncryptedStore(v, mkdtempSync(join(dir, "s-")));
}

test("creates a session and appends ordered messages", async () => {
  const sessions = new SessionStore(freshStore());
  const s = sessions.createSession({ provider: "mock", model: "m" });
  sessions.addMessage(s, "user", [{ type: "text", text: "first" }]);
  await Bun.sleep(2);
  sessions.addMessage(s, "assistant", [{ type: "text", text: "second" }]);
  const msgs = sessions.messages(s);
  expect(msgs.map((m) => m.parts[0]!.type === "text" && m.parts[0]!.text)).toEqual(["first", "second"]);
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
});

test("message contents are encrypted on disk", () => {
  const base = mkdtempSync(join(dir, "enc-"));
  const sessions = new SessionStore(new EncryptedStore(Vault.create("pw", FAST), base));
  const s = sessions.createSession({ provider: "mock", model: "m" });
  sessions.addMessage(s, "user", [{ type: "text", text: "my wallet seed phrase" }]);
  const msgDir = join(base, "messages", s.id);
  const file = readdirSync(msgDir)[0]!;
  const raw = readFileSync(join(msgDir, file), "utf8");
  expect(raw.includes("wallet seed")).toBe(false);
});

test("sessions are isolated by id", () => {
  const sessions = new SessionStore(freshStore());
  const a = sessions.createSession({ provider: "mock", model: "m" });
  const b = sessions.createSession({ provider: "mock", model: "m" });
  sessions.addMessage(a, "user", [{ type: "text", text: "in a" }]);
  expect(sessions.messages(a).length).toBe(1);
  expect(sessions.messages(b).length).toBe(0);
});
