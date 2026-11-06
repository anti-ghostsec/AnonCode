import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/crypto/vault.ts";
import { EncryptedStore } from "../src/store/store.ts";
import { EncryptedFS } from "../src/vfs/efs.ts";
import { MemoryFS } from "../src/vfs/types.ts";
import { exportProject, importProject, Runspace } from "../src/vfs/runspace.ts";

const FAST = { algo: "scrypt", N: 1 << 10, r: 8, p: 1, keyLen: 32 } as const;
const tmp = mkdtempSync(join(tmpdir(), "anoncode-vfs-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function efs(): { fs: EncryptedFS; dir: string } {
  const dir = mkdtempSync(join(tmp, "store-"));
  return { fs: new EncryptedFS(new EncryptedStore(Vault.create("pw", FAST), dir)), dir };
}

test("project files are stored as ciphertext on disk", () => {
  const { fs, dir } = efs();
  fs.write("docs/NOTES.md", Buffer.from("the secret architecture notes"));
  expect(fs.read("docs/NOTES.md")!.toString()).toBe("the secret architecture notes");
  // every on-disk blob is ciphertext — the plaintext must not appear anywhere
  const files = readdirSync(join(dir, "project"));
  for (const f of files) {
    const raw = readFileSync(join(dir, "project", f), "utf8");
    expect(raw.includes("secret architecture")).toBe(false);
  }
});

test("manifest tracks paths; remove deletes the blob", () => {
  const { fs } = efs();
  fs.write("a.ts", Buffer.from("1"));
  fs.write("b/c.ts", Buffer.from("2"));
  expect(fs.paths()).toEqual(["a.ts", "b/c.ts"]);
  fs.remove("a.ts");
  expect(fs.exists("a.ts")).toBe(false);
  expect(fs.paths()).toEqual(["b/c.ts"]);
});

test("export decrypts the whole project to a folder", () => {
  const { fs } = efs();
  fs.write("src/index.ts", Buffer.from("export const x = 1;"));
  fs.write("README.md", Buffer.from("# hi"));
  const out = mkdtempSync(join(tmp, "export-"));
  const n = exportProject(fs, out);
  expect(n).toBe(2);
  expect(readFileSync(join(out, "src/index.ts"), "utf8")).toBe("export const x = 1;");
  expect(existsSync(join(out, "README.md"))).toBe(true);
});

test("import encrypts a folder into the project (skipping junk dirs)", () => {
  const src = mkdtempSync(join(tmp, "src-"));
  const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(join(src, "node_modules"), { recursive: true });
  writeFileSync(join(src, "node_modules", "junk.js"), "nope");
  writeFileSync(join(src, "main.ts"), "console.log(1)");
  const fs = new MemoryFS();
  const n = importProject(fs, src);
  expect(n).toBe(1);
  expect(fs.paths()).toEqual(["main.ts"]);
});

test("runspace materializes, absorbs new files, and wipes", () => {
  const fs = new MemoryFS();
  fs.write("app.ts", Buffer.from("start"));
  const dir = mkdtempSync(join(tmp, "run-"));
  const rs = Runspace.materialize(fs, dir);
  expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe("start");
  // a command creates a new file in the runspace
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(join(dir, "out.txt"), "generated");
  const changed = rs.syncBack(fs);
  expect(changed).toContain("out.txt");
  expect(fs.read("out.txt")!.toString()).toBe("generated");
  rs.wipe();
  expect(existsSync(dir)).toBe(false);
});
