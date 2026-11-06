import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/crypto/vault.ts";
import { EncryptedStore } from "../src/store/store.ts";
import { EncryptedFS } from "../src/vfs/efs.ts";
import { HashingEmbedder, cosine } from "../src/search/embed.ts";
import { SemanticSearch, chunkText } from "../src/search/semantic.ts";

const FAST = { algo: "scrypt", N: 1 << 10, r: 8, p: 1, keyLen: 32 } as const;
const tmp = mkdtempSync(join(tmpdir(), "anoncode-search-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function efs(): EncryptedFS {
  return new EncryptedFS(new EncryptedStore(Vault.create("pw", FAST), mkdtempSync(join(tmp, "s-"))));
}

test("HashingEmbedder is deterministic and L2-normalized", async () => {
  const e = new HashingEmbedder(256);
  const [a] = await e.embed(["the quick brown fox"]);
  const [b] = await e.embed(["the quick brown fox"]);
  expect(cosine(a!, b!)).toBeCloseTo(1, 6); // identical text → cosine 1
  let norm = 0;
  for (const x of a!) norm += x * x;
  expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
});

test("similar text scores higher than unrelated text", async () => {
  const e = new HashingEmbedder();
  const [q] = await e.embed(["password hashing and login authentication"]);
  const [near] = await e.embed(["the auth module hashes the password on login"]);
  const [far] = await e.embed(["render the dashboard chart with colored bars"]);
  expect(cosine(q!, near!)).toBeGreaterThan(cosine(q!, far!));
});

test("chunkText windows a long file and keeps whole short files", () => {
  expect(chunkText("a\nb\nc").length).toBe(1);
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const chunks = chunkText(long, 40, 30);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0]!.startLine).toBe(1);
  expect(chunks.at(-1)!.endLine).toBe(200);
});

test("SemanticSearch ranks the relevant file first", async () => {
  const fs = efs();
  fs.write("auth.ts", Buffer.from("export function login(user, password) {\n  return bcrypt.compare(password, user.hash);\n}"));
  fs.write("chart.ts", Buffer.from("export function drawBars(data) {\n  // render colored rectangles for each value\n}"));
  fs.write("README.md", Buffer.from("# Project\nsome unrelated prose about the weather and nothing technical"));

  const hits = await new SemanticSearch().search(fs, "how are passwords checked at login", 5);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.path).toBe("auth.ts");
});

test("binary files are skipped by search", async () => {
  const fs = efs();
  fs.write("blob.bin", Buffer.from([0, 1, 2, 0, 3]));
  fs.write("note.txt", Buffer.from("searchable text about kittens"));
  const hits = await new SemanticSearch().search(fs, "kittens", 5);
  expect(hits.every((h) => h.path !== "blob.bin")).toBe(true);
});
