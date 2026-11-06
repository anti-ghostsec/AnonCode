import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/crypto/vault.ts";
import { EncryptedStore } from "../src/store/store.ts";
import { EncryptedFS } from "../src/vfs/efs.ts";
import { captureFs, restoreFs, parseBest, buildJudgeUser, pickBest } from "../src/agent/bestof.ts";
import { MockProvider } from "../src/providers/mock.ts";

const FAST = { algo: "scrypt", N: 1 << 10, r: 8, p: 1, keyLen: 32 } as const;
const tmp = mkdtempSync(join(tmpdir(), "anoncode-bestof-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function efs(): EncryptedFS {
  return new EncryptedFS(new EncryptedStore(Vault.create("pw", FAST), mkdtempSync(join(tmp, "s-"))));
}

test("captureFs/restoreFs round-trips project state (rollback between candidates)", () => {
  const fs = efs();
  fs.write("a.txt", Buffer.from("original"));
  const base = captureFs(fs);

  // A candidate mutates the project...
  fs.write("a.txt", Buffer.from("candidate edit"));
  fs.write("extra.txt", Buffer.from("new file"));
  expect(fs.read("a.txt")!.toString()).toBe("candidate edit");
  expect(fs.exists("extra.txt")).toBe(true);

  // ...and is rolled back to the captured base.
  restoreFs(fs, base);
  expect(fs.read("a.txt")!.toString()).toBe("original");
  expect(fs.exists("extra.txt")).toBe(false);
});

test("parseBest reads the chosen index and clamps out-of-range to 0", () => {
  expect(parseBest('{"best": 2, "reason": "x"}', 3)).toBe(2);
  expect(parseBest('{"best": 9}', 3)).toBe(0); // out of range → default
  expect(parseBest("no json", 3)).toBe(0);
});

test("buildJudgeUser frames candidates and the mission as untrusted data", () => {
  const u = buildJudgeUser("ship the feature", [{ text: "did A", evidence: "edit a.ts" }, { text: "did B", evidence: "edit b.ts" }]);
  expect(u).toContain("<untrusted_mission>");
  expect(u).toContain('candidate index="0"');
  expect(u).toContain('candidate index="1"');
  expect(u).toContain("did A");
});

test("pickBest returns the judge's chosen candidate index", async () => {
  const provider = new MockProvider({ reply: () => '{"best": 1, "reason": "more complete"}' });
  const { index } = await pickBest(provider, "m", "mission", [{ text: "a", evidence: "" }, { text: "b", evidence: "" }]);
  expect(index).toBe(1);
});

test("pickBest short-circuits for a single candidate", async () => {
  const provider = new MockProvider({ reply: () => "unused" });
  const { index } = await pickBest(provider, "m", "mission", [{ text: "only", evidence: "" }]);
  expect(index).toBe(0);
});
