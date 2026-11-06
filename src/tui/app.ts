import { Screen } from "./screen.ts";
import { Transcript } from "./transcript.ts";
import { LineEditor } from "./lineeditor.ts";
import { parseKeys, type Key } from "./keys.ts";
import { palette } from "./ansi.ts";
import { runAgent } from "../agent/agentloop.ts";
import { stripToolBlock } from "../agent/toolcall.ts";
import { compressHistory } from "../context/index.ts";
import { toProviderMessages } from "../agent/conversation.ts";
import { AgentLoopError } from "../agent/loopguard.ts";
import { newId } from "../store/store.ts";
import type { ContentPart } from "../session/types.ts";
import type { Provider } from "../providers/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";
import type { DiagnosticsProvider } from "../tools/diagnostics.ts";
import type { DraftModel } from "../context/draft.ts";
import type { SessionStore } from "../session/store.ts";
import type { Session } from "../session/types.ts";
import type { AppConfig } from "../config/config.ts";

type Mode = "input" | "busy" | "permission";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type TuiOptions = {
  provider: Provider;
  providerName: string;
  model: string;
  mode: "build" | "plan";
  system: string;
  draft: DraftModel;
  sessions: SessionStore;
  session: Session;
  registry: ToolRegistry;
  ctx: ToolContext;
  diagnostics: DiagnosticsProvider;
  config: AppConfig;
  onQuit: () => void;
};

export class TuiApp {
  private screen = new Screen();
  private transcript = new Transcript();
  private editor = new LineEditor();
  private mode: Mode = "input";
  private scrollOffset = 0;
  private spin = 0;
  private spinTimer: ReturnType<typeof setInterval> | null = null;
  private pending: { label: string; resolve: (ok: boolean) => void } | null = null;
  private readonly color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

  constructor(private readonly o: TuiOptions) {
    // Route tool permission requests through the UI.
    o.ctx.allow = (action, detail) => this.requestPermission(action, detail);
  }

  run(): void {
    this.transcript.add("note", `AnonCode — ${this.o.providerName} / ${this.o.model} · ${this.o.mode} mode`);
    this.transcript.add("note", "Type a message and press Enter. /exit to quit. Everything here is encrypted.");
    this.screen.start(
      (d) => this.onData(d),
      () => this.render(),
    );
    this.render();
  }

  // ---- input handling -------------------------------------------------------

  private onData(data: string): void {
    for (const key of parseKeys(data)) this.onKey(key);
  }

  private onKey(key: Key): void {
    if (key.ctrl && key.ch === "c") return this.quit();

    if (this.mode === "permission") {
      if (key.ch === "y" || key.ch === "Y") this.resolvePermission(true);
      else if (key.ch === "n" || key.ch === "N" || key.name === "escape") this.resolvePermission(false);
      return;
    }
    if (this.mode === "busy") return; // ignore typing while the agent works

    if (key.name === "pageup") {
      this.scrollOffset += Math.max(1, this.viewportHeight() - 1);
      return this.render();
    }
    if (key.name === "pagedown") {
      this.scrollOffset = Math.max(0, this.scrollOffset - (this.viewportHeight() - 1));
      return this.render();
    }

    const action = this.editor.apply(key);
    if (action === "cancel") return this.quit();
    if (action === "submit") {
      const text = this.editor.value();
      this.editor.reset();
      void this.submit(text);
      return;
    }
    this.render();
  }

  // ---- the turn -------------------------------------------------------------

  private async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") return this.render();
    if (trimmed === "/exit" || trimmed === "/quit") return this.quit();

    this.transcript.add("user", trimmed);
    this.scrollOffset = 0;
    this.setBusy(true);

    try {
      const { sessions, session, draft, config } = this.o;
      sessions.addMessage(session, "user", [{ type: "text", text: trimmed }]);

      const compressed = await compressHistory(sessions.messages(session), draft, trimmed, config.focus);
      if (compressed.report.triggered) {
        const r = compressed.report;
        this.transcript.add("note", `FOCUS kept ${r.keptCount}/${r.decisions.length} spans (${r.keptTokens}/${r.totalTokens} tok)`);
      }

      const result = await runAgent({
        provider: this.o.provider,
        model: this.o.model,
        system: this.o.system,
        messages: toProviderMessages(compressed.messages),
        registry: this.o.registry,
        ctx: this.o.ctx,
        diagnostics: this.o.diagnostics,
        onEvent: (e) => {
          if (e.type === "tool_call")
            this.transcript.add("tool", `⚙ ${e.call.tool} ${JSON.stringify(e.call.args).slice(0, 80)}`);
          else if (e.type === "tool_result")
            this.transcript.add("tool", `⤷ ${e.ok ? "ok" : "err"}: ${(e.output.split("\n")[0] ?? "").slice(0, 100)}`);
          else if (e.type === "diagnostics")
            this.transcript.add("diag", e.text.split("\n").slice(0, 6).join("\n"));
          this.render();
        },
      });

      for (const entry of result.trace) {
        if (entry.kind === "assistant") {
          const prose = stripToolBlock(entry.text);
          const parts: ContentPart[] = [];
          if (prose) parts.push({ type: "text", text: prose });
          if (entry.call) parts.push({ type: "tool_call", id: newId("call"), name: entry.call.tool, args: entry.call.args });
          if (parts.length === 0) parts.push({ type: "text", text: "(working…)" });
          sessions.addMessage(session, "assistant", parts);
        } else {
          const t = entry.diagnostics ? `${entry.output}\n[diagnostics]\n${entry.diagnostics}` : entry.output;
          sessions.addMessage(session, "tool", [{ type: "tool_result", id: newId("tr"), result: t, isError: !entry.ok }]);
        }
      }
      this.transcript.add("assistant", result.finalText);
    } catch (err) {
      if (err instanceof AgentLoopError) this.transcript.add("error", `stopped (${err.reason}): ${err.message}`);
      else this.transcript.add("error", `error: ${(err as Error).message}`);
    } finally {
      this.setBusy(false);
      this.render();
    }
  }

  private requestPermission(action: string, detail: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pending = { label: `allow ${action}: ${detail}`, resolve };
      this.mode = "permission";
      this.render();
    });
  }

  private resolvePermission(ok: boolean): void {
    const p = this.pending;
    this.pending = null;
    this.mode = "busy";
    this.render();
    p?.resolve(ok);
  }

  // ---- rendering ------------------------------------------------------------

  private viewportHeight(): number {
    return Math.max(1, this.screen.rows - 3);
  }

  private setBusy(busy: boolean): void {
    this.mode = busy ? "busy" : "input";
    if (busy && !this.spinTimer) {
      this.spinTimer = setInterval(() => {
        this.spin = (this.spin + 1) % SPINNER.length;
        this.render();
      }, 100);
    } else if (!busy && this.spinTimer) {
      clearInterval(this.spinTimer);
      this.spinTimer = null;
    }
  }

  private render(): void {
    const c = palette(this.color);
    const { rows, cols } = this.screen;
    const frame: string[] = new Array(rows).fill("");

    // Header.
    frame[0] = c.bold(c.magenta(" AnonCode ")) + c.dim(` ${this.o.providerName}/${this.o.model} · ${this.o.mode} · session ${this.o.session.id.slice(0, 12)}`);

    // Transcript viewport.
    const lines = this.transcript.render(cols, this.color);
    const vh = this.viewportHeight();
    const maxStart = Math.max(0, lines.length - vh);
    const start = Math.max(0, maxStart - this.scrollOffset);
    const view = lines.slice(start, start + vh);
    for (let i = 0; i < vh; i++) frame[1 + i] = view[i] ?? "";

    // Status line.
    if (this.mode === "permission" && this.pending) {
      frame[rows - 2] = c.yellow(`${this.pending.label}  `) + c.bold("[y/n]");
    } else if (this.mode === "busy") {
      frame[rows - 2] = c.cyan(`${SPINNER[this.spin]} working…`) + c.dim("   ⌃C to quit");
    } else {
      const hint = this.scrollOffset > 0 ? `scrolled ↑${this.scrollOffset} · PgDn to return · ` : "";
      frame[rows - 2] = c.dim(`${hint}Enter send · PgUp/PgDn scroll · /exit quit`);
    }

    // Input line.
    const prompt = c.bold(c.cyan("you ›")) + " ";
    const promptLen = 6;
    if (this.mode === "input") {
      frame[rows - 1] = prompt + this.editor.value();
    } else {
      frame[rows - 1] = c.dim("you › ") + c.dim(this.mode === "busy" ? "(working…)" : this.editor.value());
    }

    const cursorCol = this.mode === "input" ? promptLen + this.editor.cursor : promptLen;
    this.screen.render(frame, rows - 1, Math.min(cursorCol, cols - 1));
  }

  private quit(): void {
    if (this.spinTimer) clearInterval(this.spinTimer);
    this.screen.stop();
    this.o.onQuit();
  }
}
