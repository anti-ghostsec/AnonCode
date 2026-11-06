import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { Vault, type Envelope } from "../crypto/vault.ts";
import { DATA_DIR, within } from "../config/paths.ts";

/**
 * Encrypted, in-folder object store.
 *
 * Records are grouped into named collections (e.g. "sessions", "messages").
 * Every record is serialized, sealed under the vault's master key, and written
 * as an `.enc` file. The on-disk bytes are ciphertext: nothing is readable
 * without the passphrase that unlocked the vault. All data stays under
 * DATA_DIR — the store refuses any collection or id that would escape it.
 *
 * This is deliberately filesystem-based rather than a single SQLite `.db`:
 * there is no plaintext database to open externally, each record is
 * independently sealed, and writes are atomic (temp file + rename).
 */
export class EncryptedStore {
  constructor(
    private readonly vault: Vault,
    private readonly baseDir: string = DATA_DIR,
  ) {
    mkdirSync(this.baseDir, { recursive: true });
  }

  private collectionDir(collection: string): string {
    // Collections may be nested (e.g. "messages/<sessionId>"); validate each
    // segment so no part can escape the data directory.
    const parts = collection.split("/");
    for (const p of parts) assertSafeName(p, "collection");
    const dir = within(this.baseDir, ...parts);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private recordPath(collection: string, id: string): string {
    assertSafeName(id, "id");
    return join(this.collectionDir(collection), `${id}.enc`);
  }

  /** Seal and store a JSON-serializable value. */
  putJSON(collection: string, id: string, value: unknown): void {
    this.putBytes(collection, id, Buffer.from(JSON.stringify(value), "utf8"));
  }

  /** Load and decrypt a JSON value, or null if absent. */
  getJSON<T>(collection: string, id: string): T | null {
    const bytes = this.getBytes(collection, id);
    if (bytes === null) return null;
    return JSON.parse(bytes.toString("utf8")) as T;
  }

  /** Seal and store raw bytes (e.g. an attached file). Atomic write. */
  putBytes(collection: string, id: string, data: Buffer): void {
    const env = this.vault.encrypt(data);
    const file = this.recordPath(collection, id);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
    renameSync(tmp, file);
  }

  /** Load and decrypt raw bytes, or null if absent. Throws on tampering. */
  getBytes(collection: string, id: string): Buffer | null {
    const file = this.recordPath(collection, id);
    if (!existsSync(file)) return null;
    const env = JSON.parse(readFileSync(file, "utf8")) as Envelope;
    return this.vault.decrypt(env);
  }

  has(collection: string, id: string): boolean {
    return existsSync(this.recordPath(collection, id));
  }

  /** Record ids in a collection (sorted; ids are chosen to sort chronologically). */
  list(collection: string): string[] {
    const dir = this.collectionDir(collection);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".enc"))
      .map((f) => f.slice(0, -".enc".length))
      .sort();
  }

  remove(collection: string, id: string): void {
    const file = this.recordPath(collection, id);
    if (existsSync(file)) rmSync(file);
  }
}

/**
 * Allow only characters that cannot form a path component escape. This blocks
 * `/`, `..`, NUL, etc. Ids are generated internally (see newId) and always
 * satisfy this; the check defends against any externally-influenced value.
 */
function assertSafeName(name: string, kind: string): void {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) {
    throw new Error(`unsafe ${kind} name: ${JSON.stringify(name)}`);
  }
}

/**
 * Sortable, collision-resistant id: millisecond timestamp (base36, zero-padded)
 * + random suffix. Lexical order matches creation order.
 */
export function newId(prefix = ""): string {
  const ts = Date.now().toString(36).padStart(9, "0");
  const rand = Math.random().toString(36).slice(2, 10);
  const id = `${ts}-${rand}`;
  return prefix ? `${prefix}-${id}` : id;
}
