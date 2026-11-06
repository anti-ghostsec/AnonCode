import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  existsSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import type { AgentFS } from "./types.ts";

/**
 * Ephemeral plaintext mirror of the encrypted project, used ONLY so that real
 * tools (compilers, test runners, linters, shell commands) can run — they need
 * files on disk. The runspace:
 *   - is materialized from the EncryptedFS when an active session needs it,
 *   - is kept current by the file tools (which write-through to it),
 *   - absorbs files that commands create via `syncBack` (re-encrypted into EFS),
 *   - and is WIPED when the session ends.
 *
 * At rest (no active session) only ciphertext remains. While a session runs,
 * plaintext exists here transiently — unavoidable for executing real tooling —
 * and it stays inside the AnonCode folder.
 */

const SKIP = new Set([".git", "node_modules", ".anoncode", "dist", ".next", "target"]);

export class Runspace {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  static materialize(fs: AgentFS, dir: string): Runspace {
    const rs = new Runspace(dir);
    for (const p of fs.paths()) {
      const data = fs.read(p);
      if (data) rs.put(p, data);
    }
    return rs;
  }

  put(path: string, data: Buffer): void {
    const abs = join(this.dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
  }

  /** Import files the commands created/changed back into the encrypted FS.
   * Skips build/dependency dirs and anything over the size cap. */
  syncBack(fs: AgentFS, maxBytes = 1_000_000): string[] {
    const changed: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          if (statSync(full).size > maxBytes) continue;
          const rel = relative(this.dir, full);
          const data = readFileSync(full);
          const prev = fs.read(rel);
          if (!prev || !prev.equals(data)) {
            fs.write(rel, data);
            changed.push(rel);
          }
        }
      }
    };
    if (existsSync(this.dir)) walk(this.dir);
    return changed;
  }

  wipe(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Decrypt the whole project to a real folder (the deliberate "unlock").
 * Returns the number of files written. */
export function exportProject(fs: AgentFS, targetDir: string): number {
  mkdirSync(targetDir, { recursive: true });
  let n = 0;
  for (const p of fs.paths()) {
    const data = fs.read(p);
    if (!data) continue;
    const abs = join(targetDir, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
    n++;
  }
  return n;
}

/** Encrypt an existing folder's files into the project FS. Returns the count. */
export function importProject(fs: AgentFS, sourceDir: string, maxBytes = 2_000_000): number {
  let n = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        if (statSync(full).size > maxBytes) continue;
        fs.write(relative(sourceDir, full), readFileSync(full));
        n++;
      }
    }
  };
  walk(sourceDir);
  return n;
}
