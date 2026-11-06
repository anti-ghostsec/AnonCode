import { createHash } from "node:crypto";
import { EncryptedStore, newId } from "../store/store.ts";
import type { AgentFS } from "./types.ts";

/**
 * Encrypted, content-addressed project snapshots — turn-level undo.
 *
 * Each snapshot records a manifest of {path -> contentHash}. The file bytes are
 * stored once per distinct content under the BLOBS collection, so files that
 * don't change between snapshots aren't duplicated. Everything is sealed in the
 * vault exactly like the rest of the project: undo never materializes plaintext
 * on disk and nothing leaves the folder.
 *
 * The server takes one snapshot before each user turn (in build mode), giving a
 * natural "undo the last change" that walks back one turn at a time.
 */

export type SnapshotMeta = {
  id: string;
  /** Monotonic order index — robust chronological order even when several
   * snapshots are created within the same millisecond (ids would tie). */
  seq: number;
  label: string;
  createdAt: string;
  /** Fingerprint of the FS state, used to skip no-op snapshots. */
  fingerprint: string;
  files: Record<string, { hash: string; size: number }>;
};

const META = "snapshots"; // id -> SnapshotMeta
const BLOBS = "snapblobs"; // contentHash -> file bytes (deduplicated)

export class SnapshotStore {
  constructor(private readonly store: EncryptedStore) {}

  private hashBytes(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex");
  }

  /** A stable fingerprint of the current project state (sorted path + hash). */
  fingerprint(fs: AgentFS): string {
    const h = createHash("sha256");
    for (const p of fs.paths()) {
      const d = fs.read(p);
      h.update(p).update("\0").update(d ? this.hashBytes(d) : "-").update("\n");
    }
    return h.digest("hex").slice(0, 16);
  }

  /** Snapshot metas, oldest first (by monotonic seq, not id/time). */
  list(): SnapshotMeta[] {
    return this.store
      .list(META)
      .map((id) => this.store.getJSON<SnapshotMeta>(META, id))
      .filter((s): s is SnapshotMeta => s !== null)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  /**
   * Take a snapshot of the current project. Returns the meta, or null when the
   * project is identical to the most recent snapshot (nothing to record).
   */
  snapshot(fs: AgentFS, label: string, keep = 25): SnapshotMeta | null {
    const fp = this.fingerprint(fs);
    const all = this.list();
    const latest = all[all.length - 1];
    if (latest && latest.fingerprint === fp) return null;

    const files: Record<string, { hash: string; size: number }> = {};
    for (const p of fs.paths()) {
      const d = fs.read(p);
      if (!d) continue;
      const h = this.hashBytes(d);
      if (!this.store.has(BLOBS, h)) this.store.putBytes(BLOBS, h, d); // dedup
      files[p] = { hash: h, size: d.length };
    }
    const meta: SnapshotMeta = {
      id: newId("snap"),
      seq: (latest?.seq ?? 0) + 1,
      label: (label || "snapshot").trim().slice(0, 80),
      createdAt: new Date().toISOString(),
      fingerprint: fp,
      files,
    };
    this.store.putJSON(META, meta.id, meta);
    this.prune(keep);
    return meta;
  }

  /** Restore the project to a snapshot: rewrite its files, drop any extras. */
  restore(fs: AgentFS, id: string): boolean {
    const meta = this.store.getJSON<SnapshotMeta>(META, id);
    if (!meta) return false;
    const want = new Set(Object.keys(meta.files));
    for (const p of fs.paths()) if (!want.has(p)) fs.remove(p);
    for (const [p, info] of Object.entries(meta.files)) {
      const bytes = this.store.getBytes(BLOBS, info.hash);
      if (bytes) fs.write(p, bytes);
    }
    return true;
  }

  /** Undo: restore the most recent snapshot and consume it (walk back a turn). */
  undo(fs: AgentFS): SnapshotMeta | null {
    const all = this.list();
    const latest = all[all.length - 1];
    if (!latest) return null;
    this.restore(fs, latest.id);
    this.store.remove(META, latest.id);
    return latest;
  }

  private prune(keep: number): void {
    const all = this.list();
    if (all.length <= keep) return;
    for (const old of all.slice(0, all.length - keep)) this.store.remove(META, old.id);
  }
}
