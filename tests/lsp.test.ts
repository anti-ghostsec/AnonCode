import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient } from "../src/lsp/client.ts";
import type { LspTransport } from "../src/lsp/transport.ts";
import { LspDiagnostics, type ServerSpec } from "../src/lsp/diagnostics.ts";

const tmp = mkdtempSync(join(tmpdir(), "anoncode-lsp-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A controllable in-memory transport for driving the client in tests. */
class FakeTransport implements LspTransport {
  private cb: ((m: unknown) => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  send(msg: unknown): void {
    this.sent.push(msg as Record<string, unknown>);
  }
  onMessage(cb: (m: unknown) => void): void {
    this.cb = cb;
  }
  onClose(): void {}
  close(): void {}
  emit(msg: unknown): void {
    this.cb?.(msg);
  }
}

test("client correlates a request with its response", async () => {
  const t = new FakeTransport();
  const client = new LspClient(t);
  const p = client.request("initialize", {});
  const sent = t.sent[0]!;
  expect(sent.method).toBe("initialize");
  t.emit({ jsonrpc: "2.0", id: sent.id, result: { capabilities: {} } });
  expect(await p).toEqual({ capabilities: {} });
});

test("publishDiagnostics is stored and notified", () => {
  const t = new FakeTransport();
  const client = new LspClient(t);
  const seen: string[] = [];
  client.onDiagnostics((uri) => seen.push(uri));
  t.emit({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri: "file:///x.ts", diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "bad" }] },
  });
  expect(seen).toEqual(["file:///x.ts"]);
  expect(client.getDiagnostics("file:///x.ts")[0]!.message).toBe("bad");
});

/** Fake server: answers initialize, and on didOpen publishes one error. */
function fakeServerFactory(): (spec: ServerSpec, root: string) => LspTransport {
  return () => {
    const t = new FakeTransport();
    const realSend = t.send.bind(t);
    t.send = (msg: unknown) => {
      realSend(msg);
      const m = msg as Record<string, unknown>;
      if (m.method === "initialize") {
        queueMicrotask(() => t.emit({ jsonrpc: "2.0", id: m.id, result: { capabilities: {} } }));
      } else if (m.method === "textDocument/didOpen") {
        const uri = (m.params as any).textDocument.uri as string;
        queueMicrotask(() =>
          t.emit({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: {
              uri,
              diagnostics: [
                { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, severity: 1, message: "Type 'string' is not assignable to type 'number'.", source: "ts" },
              ],
            },
          }),
        );
      }
    };
    return t;
  };
}

test("LspDiagnostics.check reports a server's error for a changed file", async () => {
  writeFileSync(join(tmp, "x.ts"), "const n: number = 'bad';\n");
  const specs: ServerSpec[] = [{ id: "ts", extensions: ["ts"], command: "fake", args: [] }];
  const diag = new LspDiagnostics(specs, { debounceMs: 5, timeoutMs: 300, initTimeoutMs: 300 }, fakeServerFactory());
  const out = await diag.check(["x.ts"], tmp);
  expect(out).toContain("x.ts:1:7: error");
  expect(out).toContain("not assignable");
  diag.dispose();
});

test("missing server binary is skipped, returning no diagnostics", async () => {
  const specs: ServerSpec[] = [{ id: "ts", extensions: ["ts"], command: "fake", args: [] }];
  // factory returns null => simulates an uninstalled language server
  const diag = new LspDiagnostics(specs, { debounceMs: 5, timeoutMs: 100, initTimeoutMs: 100 }, () => null);
  writeFileSync(join(tmp, "y.ts"), "ok\n");
  expect(await diag.check(["y.ts"], tmp)).toBe("");
  diag.dispose();
});
