import { spawn } from "node:child_process";
import { encodeMessage, MessageReader } from "./framing.ts";

/**
 * Abstract transport between the LSP client and a server. Abstracted so the
 * client can be driven by a real child process in production and by a scripted
 * fake in tests (no language-server binary required).
 */
export interface LspTransport {
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/** Transport backed by a child process speaking LSP over stdio. */
export class StdioTransport implements LspTransport {
  private reader = new MessageReader();
  private msgCb: ((m: unknown) => void) | null = null;
  private closeCb: (() => void) | null = null;

  constructor(private readonly child: ReturnType<typeof spawn>) {
    child.stdout?.on("data", (d: Buffer) => this.reader.push(d, (m) => this.msgCb?.(m)));
    child.stderr?.on("data", () => {}); // drain; servers log noise here
    child.on("close", () => this.closeCb?.());
    child.on("error", () => this.closeCb?.());
  }

  send(msg: unknown): void {
    this.child.stdin?.write(encodeMessage(msg));
  }
  onMessage(cb: (m: unknown) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Spawn a language server and wrap it, or return null if its binary is absent. */
export function spawnStdioTransport(command: string, args: string[], cwd: string): LspTransport | null {
  const bin = typeof Bun !== "undefined" ? Bun.which(command) : command;
  if (!bin) return null;
  try {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    return new StdioTransport(child);
  } catch {
    return null;
  }
}
