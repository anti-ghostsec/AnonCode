import { test, expect } from "bun:test";
import { Vault, WrongPassphraseError } from "../src/crypto/vault.ts";

// Use a cheap KDF in tests so they run fast; production uses the strong default.
const FAST = { algo: "scrypt", N: 1 << 10, r: 8, p: 1, keyLen: 32 } as const;

test("encrypt/decrypt round-trips", () => {
  const v = Vault.create("correct horse battery staple", FAST);
  const data = Buffer.from("secret chat message \u{1F510}", "utf8");
  const env = v.encrypt(data);
  expect(v.decrypt(env).equals(data)).toBe(true);
});

test("ciphertext does not contain the plaintext", () => {
  const v = Vault.create("pw", FAST);
  const secret = "TOP-SECRET-NEEDLE";
  const env = v.encryptString(secret);
  const raw = JSON.stringify(env);
  expect(raw.includes(secret)).toBe(false);
  // base64 ciphertext should not reveal the ascii either
  expect(Buffer.from(env.ct, "base64").toString("utf8").includes(secret)).toBe(false);
});

test("unlock succeeds with the right passphrase and fails with the wrong one", () => {
  const v = Vault.create("hunter2hunter2", FAST);
  const header = v.header;
  expect(() => Vault.unlock("hunter2hunter2", header)).not.toThrow();
  expect(() => Vault.unlock("wrong-pass", header)).toThrow(WrongPassphraseError);
});

test("tampered ciphertext fails authentication", () => {
  const v = Vault.create("pw", FAST);
  const env = v.encryptString("payload");
  const ctBytes = Buffer.from(env.ct, "base64");
  ctBytes[0] = ctBytes[0]! ^ 0xff; // flip a bit
  const tampered = { ...env, ct: ctBytes.toString("base64") };
  expect(() => v.decrypt(tampered)).toThrow();
});

test("different salts yield different keys for the same passphrase", () => {
  const a = Vault.create("same-pass", FAST);
  const b = Vault.create("same-pass", FAST);
  expect(a.header.salt).not.toBe(b.header.salt);
  // b cannot open a's verifier
  expect(() => Vault.unlock("same-pass", a.header)).not.toThrow();
});
