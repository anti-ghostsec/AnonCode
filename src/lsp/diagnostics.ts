import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DiagnosticsProvider } from "../tools/diagnostics.ts";
import { LspClient, type Diagnostic } from "./client.ts";
import { type LspTransport, spawnStdioTransport } from "./transport.ts";

/**
 * Real LSP-backed diagnostics — the live, per-file version of opencode's
 * environment-correction loop.
 *
 * After an edit, AnonCode opens/updates the changed files in the appropriate
 * language server (rooted at the runspace, where the plaintext mirror lives),
 * waits briefly for the server to publish diagnostics (debounce + overall
 * timeout), and returns the errors/warnings formatted for the model.
 *
 * Servers are launched lazily, kept alive across edits, and killed on dispose.
 * If a server binary is not installed, that language is simply skipped — the
 * agent loop continues, never blocked by missing tooling.
 */

export type ServerSpec = {
  id: string;
  extensions: string[];
  command: string;
  args: string[];
};

export const DEFAULT_SERVERS: ServerSpec[] = [
  { id: "typescript", extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs"], command: "typescript-language-server", args: ["--stdio"] },
  { id: "python", extensions: ["py"], command: "pyright-langserver", args: ["--stdio"] },
  { id: "rust", extensions: ["rs"], command: "rust-analyzer", args: [] },
  { id: "go", extensions: ["go"], command: "gopls", args: [] },
];

export type LspOptions = {
  debounceMs: number;
  timeoutMs: number;
  initTimeoutMs: number;
};

const DEFAULT_OPTS: LspOptions = { debounceMs: 150, timeoutMs: 3000, initTimeoutMs: 5000 };

type TransportFactory = (spec: ServerSpec, rootDir: string) => LspTransport | null;

type Running = { client: LspClient; opened: Map<string, number> };

export class LspDiagnostics implements DiagnosticsProvider {
  private servers = new Map<string, Running>();

  constructor(
    private readonly specs: ServerSpec[] = DEFAULT_SERVERS,
    private readonly opts: LspOptions = DEFAULT_OPTS,
    private readonly makeTransport: TransportFactory = (s, root) => spawnStdioTransport(s.command, s.args, root),
  ) {}

  async check(changedFiles: string[], rootDir: string): Promise<string> {
    try {
      return await this.run(changedFiles, rootDir);
    } catch {
      return ""; // never break the agent loop over diagnostics
    }
  }

  dispose(): void {
    for (const r of this.servers.values()) r.client.close();
    this.servers.clear();
  }

  private specFor(path: string): ServerSpec | undefined {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return this.specs.find((s) => s.extensions.includes(ext));
  }

  private async run(changedFiles: string[], rootDir: string): Promise<string> {
    const groups = new Map<string, { spec: ServerSpec; files: string[] }>();
    for (const f of changedFiles) {
      const spec = this.specFor(f);
      if (!spec) continue;
      const g = groups.get(spec.id) ?? { spec, files: [] };
      g.files.push(f);
      groups.set(spec.id, g);
    }

    const out: string[] = [];
    for (const { spec, files } of groups.values()) {
      const running = await this.ensure(spec, rootDir);
      if (!running) continue;

      const uris: string[] = [];
      for (const rel of files) {
        const abs = join(rootDir, rel);
        if (!existsSync(abs)) continue;
        const text = readFileSync(abs, "utf8");
        const uri = pathToUri(abs);
        uris.push(uri);
        const version = (running.opened.get(uri) ?? 0) + 1;
        running.opened.set(uri, version);
        if (version === 1) {
          running.client.notify("textDocument/didOpen", {
            textDocument: { uri, languageId: languageId(rel), version: 1, text },
          });
        } else {
          running.client.notify("textDocument/didChange", {
            textDocument: { uri, version },
            contentChanges: [{ text }],
          });
        }
      }

      await this.waitForDiagnostics(running.client, uris);

      for (const rel of files) {
        const uri = pathToUri(join(rootDir, rel));
        for (const d of running.client.getDiagnostics(uri)) {
          if (d.severity === 1 || d.severity === 2) out.push(format(rel, d));
        }
      }
    }
    return out.slice(0, 50).join("\n");
  }

  private async ensure(spec: ServerSpec, rootDir: string): Promise<Running | null> {
    const existing = this.servers.get(spec.id);
    if (existing) return existing;
    const transport = this.makeTransport(spec, rootDir);
    if (!transport) return null;
    const client = new LspClient(transport);
    try {
      await withTimeout(client.initialize(pathToUri(rootDir)), this.opts.initTimeoutMs);
    } catch {
      client.close();
      return null;
    }
    const running: Running = { client, opened: new Map() };
    this.servers.set(spec.id, running);
    return running;
  }

  /** Resolve after a quiet debounce following the last relevant publish, or at
   * the overall timeout — whichever comes first. */
  private waitForDiagnostics(client: LspClient, uris: string[]): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let debounce: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(overall);
        if (debounce) clearTimeout(debounce);
        off();
        resolve();
      };
      const overall = setTimeout(finish, this.opts.timeoutMs);
      const off = client.onDiagnostics((uri) => {
        if (!uris.includes(uri)) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(finish, this.opts.debounceMs);
      });
    });
  }
}

function format(rel: string, d: Diagnostic): string {
  const sev = d.severity === 2 ? "warning" : "error";
  const line = d.range.start.line + 1;
  const col = d.range.start.character + 1;
  const src = d.source ? ` (${d.source})` : "";
  return `${rel}:${line}:${col}: ${sev}${src}: ${d.message}`;
}

function languageId(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts": return "typescript";
    case "tsx": return "typescriptreact";
    case "js": case "mjs": case "cjs": return "javascript";
    case "jsx": return "javascriptreact";
    case "py": return "python";
    case "rs": return "rust";
    case "go": return "go";
    default: return "plaintext";
  }
}

function pathToUri(p: string): string {
  return "file://" + p.split("/").map(encodeURIComponent).join("/");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
