import { createHash } from "node:crypto";
import type { EncryptedStore } from "../store/store.ts";
import { type AgentFS, normVPath } from "./types.ts";

/**
 * Encrypted project filesystem.
 *
 * Every project file — source, docs, AGENTS.md, anything the agent creates or
 * downloads — is stored as a separate AES-256-GCM blob in the vault. The file
 * path maps to a blob id by hash; a single encrypted manifest records the set
 * of paths (so the project can be listed without a plaintext index). The bytes
 * on disk are ciphertext: the whole project is unreadable without the
 * passphrase. Nothing is ever written in plaintext — use `export` for that.
 */

type Manifest = Record<string, { size: number; mtime: number }>;

export class EncryptedFS implements AgentFS {
  private manifest: Manifest;

  constructor(
    private readonly store: EncryptedStore,
    private readonly collection = "project",
  ) {
    this.manifest = store.getJSON<Manifest>(collection, "manifest") ?? {};
  }

  private blobId(path: string): string {
    return "f" + createHash("sha256").update(path).digest("hex");
  }

  private persist(): void {
    this.store.putJSON(this.collection, "manifest", this.manifest);
  }

  read(path: string): Buffer | null {
    const p = normVPath(path);
    if (!(p in this.manifest)) return null;
    return this.store.getBytes(this.collection, this.blobId(p));
  }

  write(path: string, data: Buffer): void {
    const p = normVPath(path);
    if (p === "") throw new Error("cannot write to the project root");
    this.store.putBytes(this.collection, this.blobId(p), Buffer.from(data));
    this.manifest[p] = { size: data.length, mtime: Date.now() };
    this.persist();
  }

  exists(path: string): boolean {
    return normVPath(path) in this.manifest;
  }

  remove(path: string): void {
    const p = normVPath(path);
    if (p in this.manifest) {
      this.store.remove(this.collection, this.blobId(p));
      delete this.manifest[p];
      this.persist();
    }
  }

  paths(): string[] {
    return Object.keys(this.manifest).sort();
  }
}
