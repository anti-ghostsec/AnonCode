import type { LspTransport } from "./transport.ts";

/** A single LSP diagnostic (subset we use). */
export type Diagnostic = {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number; // 1 Error, 2 Warning, 3 Info, 4 Hint
  message: string;
  source?: string;
};

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * Minimal LSP client: issues id-correlated requests, sends notifications, and
 * tracks the latest `publishDiagnostics` per document URI. It answers the few
 * server→client requests a language server makes during startup so handshakes
 * don't stall.
 */
export class LspClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private diagListeners = new Set<(uri: string) => void>();

  constructor(private readonly transport: LspTransport) {
    transport.onMessage((m) => this.handle(m as Record<string, unknown>));
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.transport.send({ jsonrpc: "2.0", method, params });
  }

  getDiagnostics(uri: string): Diagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  /** Subscribe to publishDiagnostics; returns an unsubscribe function. */
  onDiagnostics(cb: (uri: string) => void): () => void {
    this.diagListeners.add(cb);
    return () => this.diagListeners.delete(cb);
  }

  async initialize(rootUri: string): Promise<void> {
    await this.request("initialize", {
      processId: typeof process !== "undefined" ? process.pid : null,
      rootUri,
      workspaceFolders: rootUri ? [{ uri: rootUri, name: "project" }] : null,
      capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } } },
    });
    this.notify("initialized", {});
  }

  close(): void {
    this.transport.close();
  }

  private handle(m: Record<string, unknown>): void {
    // Response to one of our requests.
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = this.pending.get(m.id as number);
      if (p) {
        this.pending.delete(m.id as number);
        if (m.error) p.reject(new Error((m.error as { message?: string }).message ?? "lsp error"));
        else p.resolve(m.result);
      }
      return;
    }
    // Server-initiated request: answer so the handshake proceeds.
    if (m.id !== undefined && typeof m.method === "string") {
      let result: unknown = null;
      const params = m.params as { items?: unknown[] } | undefined;
      if (m.method === "workspace/configuration" && Array.isArray(params?.items)) {
        result = params!.items!.map(() => ({}));
      }
      this.transport.send({ jsonrpc: "2.0", id: m.id, result });
      return;
    }
    // Notifications.
    if (m.method === "textDocument/publishDiagnostics") {
      const params = m.params as { uri: string; diagnostics: Diagnostic[] };
      this.diagnostics.set(params.uri, params.diagnostics ?? []);
      for (const cb of this.diagListeners) cb(params.uri);
    }
  }
}
