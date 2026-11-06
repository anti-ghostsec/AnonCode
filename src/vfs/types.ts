/**
 * The agent's filesystem abstraction. AnonCode's agent never touches the real
 * disk for project files — it goes through an AgentFS so that every file it
 * reads or creates can be encrypted at rest (see EncryptedFS). Paths are
 * virtual, normalized, and confined to the project root (no `..` escapes).
 */
export interface AgentFS {
  read(path: string): Buffer | null;
  write(path: string, data: Buffer): void;
  exists(path: string): boolean;
  remove(path: string): void;
  /** All file paths, normalized and sorted. */
  paths(): string[];
}

/** Normalize a virtual path and reject anything that escapes the root. */
export function normVPath(p: string): string {
  if (typeof p !== "string") throw new Error("path is required");
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new Error(`path escapes project root: ${p}`);
    parts.push(seg);
  }
  return parts.join("/");
}

/** In-memory AgentFS — for tests and ephemeral use. Not encrypted. */
export class MemoryFS implements AgentFS {
  private files = new Map<string, Buffer>();
  read(path: string): Buffer | null {
    const v = this.files.get(normVPath(path));
    return v ? Buffer.from(v) : null;
  }
  write(path: string, data: Buffer): void {
    this.files.set(normVPath(path), Buffer.from(data));
  }
  exists(path: string): boolean {
    return this.files.has(normVPath(path));
  }
  remove(path: string): void {
    this.files.delete(normVPath(path));
  }
  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}
