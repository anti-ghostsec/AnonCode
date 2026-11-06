import { spawn } from "node:child_process";
import { relative } from "node:path";

/**
 * Diagnostics feedback — the technique that makes weak models competent.
 *
 * opencode pushes each edit to a language server and feeds the resulting
 * errors back to the model so it fixes them on the next step. AnonCode exposes
 * the same loop behind a pluggable provider:
 *
 *   - NoDiagnostics: default; returns nothing.
 *   - CommandDiagnostics: runs a configured checker (e.g. `tsc --noEmit`,
 *     `eslint`, `ruff`, `cargo check`) and returns the lines that mention the
 *     files just edited. Zero-config and language-agnostic.
 *
 * A full LSP client can later implement the same interface for live,
 * per-file diagnostics with a debounce — the agent loop doesn't change.
 */
export interface DiagnosticsProvider {
  /** Return diagnostics text for the changed files, or "" if clean/none. */
  check(changedFiles: string[], root: string): Promise<string>;
  /** Release any held resources (e.g. kill language servers). */
  dispose?(): void;
}

export class NoDiagnostics implements DiagnosticsProvider {
  async check(): Promise<string> {
    return "";
  }
}

export class CommandDiagnostics implements DiagnosticsProvider {
  constructor(
    private readonly command: string,
    private readonly timeoutMs = 20000,
  ) {}

  async check(changedFiles: string[], root: string): Promise<string> {
    const { out } = await run(this.command, root, this.timeoutMs);
    if (!out.trim()) return "";
    const rels = changedFiles.map((f) => relative(root, f));
    // Keep only lines mentioning a changed file; if none match, return a short tail.
    const relevant = out
      .split("\n")
      .filter((line) => rels.some((r) => line.includes(r)))
      .slice(0, 50);
    if (relevant.length > 0) return relevant.join("\n");
    return out.split("\n").slice(0, 20).join("\n");
  }
}

function run(command: string, cwd: string, timeoutMs: number): Promise<{ out: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ out: out + `\n[diagnostics spawn error] ${e.message}` });
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ out });
    });
  });
}
