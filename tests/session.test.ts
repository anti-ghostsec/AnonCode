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

test("a reopened store resumes the most recent session and its messages (restart)", async () => {
  // Models the restart fix: the server rebuilds SessionStore over the same
  // vault and must resume the latest session rather than start a blank one.
  const base = mkdtempSync(join(dir, "resume-"));
  const v = Vault.create("pw", FAST);
  const first = new SessionStore(new EncryptedStore(v, base));
  const older = first.createSession({ provider: "mock", model: "m" });
  await Bun.sleep(2);
  const newer = first.createSession({ provider: "mock", model: "m" });
  first.addMessage(newer, "user", [{ type: "text", text: "remember this across restart" }]);

  // "Restart": a brand-new SessionStore over the same encrypted store.
  const reopened = new SessionStore(new EncryptedStore(Vault.unlock("pw", v.header), base));
  const prior = reopened.listSessions();
  expect(prior.length).toBe(2);
  const resumed = prior.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
  expect(resumed.id).toBe(newer.id); // the most recently-active one
  const texts = reopened.messages(resumed).map((m) => (m.parts[0]!.type === "text" ? m.parts[0]!.text : ""));
  expect(texts).toContain("remember this across restart");
});

test("sessions are isolated by id", () => {
  const sessions = new SessionStore(freshStore());
  const a = sessions.createSession({ provider: "mock", model: "m" });
  const b = sessions.createSession({ provider: "mock", model: "m" });
  sessions.addMessage(a, "user", [{ type: "text", text: "in a" }]);
  expect(sessions.messages(a).length).toBe(1);
  expect(sessions.messages(b).length).toBe(0);
});
