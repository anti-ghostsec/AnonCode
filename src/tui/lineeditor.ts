import type { Key } from "./keys.ts";

/**
 * Single-line input editor: a pure state machine over key events. Supports
 * cursor movement, editing, kill-line, and input history. `apply` returns an
 * action for the host to act on ("submit"/"cancel") or null.
 */
export class LineEditor {
  buffer = "";
  cursor = 0;
  private history: string[] = [];
  private histIndex = -1;
  private stash = "";

  value(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = "";
    this.cursor = 0;
    this.histIndex = -1;
  }

  apply(key: Key): "submit" | "cancel" | null {
    if (key.ctrl && key.ch === "c") return "cancel";
    if (key.ctrl && key.ch === "d" && this.buffer === "") return "cancel";
    if (key.ctrl && key.ch === "u") {
      this.buffer = this.buffer.slice(this.cursor);
      this.cursor = 0;
      return null;
    }
    if (key.ctrl && key.ch === "a") {
      this.cursor = 0;
      return null;
    }
    if (key.ctrl && key.ch === "e") {
      this.cursor = this.buffer.length;
      return null;
    }
    switch (key.name) {
      case "return": {
        const v = this.buffer;
        if (v.trim()) this.history.unshift(v);
        this.histIndex = -1;
        return "submit";
      }
      case "backspace":
        if (this.cursor > 0) {
          this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
          this.cursor--;
        }
        return null;
      case "delete":
        this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
        return null;
      case "left":
        if (this.cursor > 0) this.cursor--;
        return null;
      case "right":
        if (this.cursor < this.buffer.length) this.cursor++;
        return null;
      case "home":
        this.cursor = 0;
        return null;
      case "end":
        this.cursor = this.buffer.length;
        return null;
      case "up":
        this.historyPrev();
        return null;
      case "down":
        this.historyNext();
        return null;
    }
    if (key.ch && !key.ctrl) {
      this.buffer = this.buffer.slice(0, this.cursor) + key.ch + this.buffer.slice(this.cursor);
      this.cursor += key.ch.length;
    }
    return null;
  }

  private historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.histIndex === -1) this.stash = this.buffer;
    this.histIndex = Math.min(this.histIndex + 1, this.history.length - 1);
    this.buffer = this.history[this.histIndex]!;
    this.cursor = this.buffer.length;
  }

  private historyNext(): void {
    if (this.histIndex === -1) return;
    this.histIndex--;
    this.buffer = this.histIndex === -1 ? this.stash : this.history[this.histIndex]!;
    this.cursor = this.buffer.length;
  }
}
