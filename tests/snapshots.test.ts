import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/crypto/vault.ts";
import { EncryptedStore } from "../src/store/store.ts";
import { EncryptedFS } from "../src/vfs/efs.ts";
import { SnapshotStore } from "../src/vfs/snapshots.ts";

const FAST = { algo: "scrypt", N: 1 << 10, r: 8, p: 1, keyLen: 32 } as const;
const tmp = mkdtempSync(join(tmpdir(), "anoncode-snap-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function setup(): { fs: EncryptedFS; snaps: SnapshotStore } {
  const dir = mkdtempSync(join(tmp, "store-"));
  const store = new EncryptedStore(Vault.create("pw", FAST), dir);
  return { fs: new EncryptedFS(store), snaps: new SnapshotStore(store) };
}

test("undo reverts the most recent change", () => {
  const { fs, snaps } = setup();
  fs.write("a.txt", Buffer.from("v1"));
  snaps.snapshot(fs, "before edit"); // checkpoint v1
  fs.write("a.txt", Buffer.from("v2")); // the change
  expect(fs.read("a.txt")!.toString()).toBe("v2");

  const undone = snaps.undo(fs);
  expect(undone).not.toBeNull();
  expect(fs.read("a.txt")!.toString()).toBe("v1");
});

test("undo removes files created after the checkpoint", () => {
  const { fs, snaps } = setup();
  fs.write("keep.txt", Buffer.from("x"));
  snaps.snapshot(fs, "before");
  fs.write("new.txt", Buffer.from("y"));
  expect(fs.exists("new.txt")).toBe(true);

  snaps.undo(fs);
  expect(fs.exists("new.txt")).toBe(false);
  expect(fs.exists("keep.txt")).toBe(true);
});

test("a no-op snapshot (unchanged project) is skipped", () => {
  const { fs, snaps } = setup();
  fs.write("a.txt", Buffer.from("v1"));
  expect(snaps.snapshot(fs, "first")).not.toBeNull();
  expect(snaps.snapshot(fs, "again")).toBeNull(); // nothing changed
  expect(snaps.list().length).toBe(1);
});

test("undo walks back turn by turn", () => {
  const { fs, snaps } = setup();
  fs.write("a.txt", Buffer.from("1"));
  snaps.snapshot(fs, "t1");
  fs.write("a.txt", Buffer.from("2"));
  snaps.snapshot(fs, "t2");
  fs.write("a.txt", Buffer.from("3"));

  snaps.undo(fs); // -> state at t2 (which held "2")
  expect(fs.read("a.txt")!.toString()).toBe("2");
  snaps.undo(fs); // -> state at t1 (which held "1")
  expect(fs.read("a.txt")!.toString()).toBe("1");
  expect(snaps.undo(fs)).toBeNull(); // nothing left
});

test("identical content across snapshots is stored once (deduplicated blobs)", () => {
  const { fs, snaps } = setup();
  fs.write("a.txt", Buffer.from("same"));
  snaps.snapshot(fs, "s1");
  fs.write("b.txt", Buffer.from("same")); // identical content, different path
  snaps.snapshot(fs, "s2");
  // Both snapshot manifests reference the one content hash for "same".
  const metas = snaps.list();
  const hashes = new Set(metas.flatMap((m) => Object.values(m.files).map((f) => f.hash)));
  expect(hashes.size).toBe(1);
});
