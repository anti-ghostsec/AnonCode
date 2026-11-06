import { seq, truncate } from "./ansi.ts";

/**
 * Owns the real terminal: alternate screen buffer, raw-mode input, and frame
 * rendering. A frame is an array of lines (one per row); `render` writes it in
 * a single pass and parks the cursor.
 */
export class Screen {
  private dataCb: ((d: string) => void) | null = null;
  private resizeCb: (() => void) | null = null;

  get rows(): number {
    return process.stdout.rows ?? 24;
  }
  get cols(): number {
    return process.stdout.columns ?? 80;
  }

  start(onData: (d: string) => void, onResize: () => void): void {
    this.dataCb = onData;
    this.resizeCb = onResize;
    process.stdout.write(seq.altScreen + seq.clearScreen + seq.home);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdout.on("resize", onResize);
  }

  stop(): void {
    if (this.dataCb) process.stdin.off("data", this.dataCb);
    if (this.resizeCb) process.stdout.off("resize", this.resizeCb);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(seq.showCursor + seq.mainScreen);
  }

  render(frame: string[], cursorRow: number, cursorCol: number): void {
    const { rows, cols } = this;
    let out = seq.hideCursor + seq.home;
    for (let r = 0; r < rows; r++) {
      out += truncate(frame[r] ?? "", cols) + seq.clearLine + (r < rows - 1 ? "\r\n" : "");
    }
    out += seq.moveTo(cursorRow + 1, cursorCol + 1) + seq.showCursor;
    process.stdout.write(out);
  }
}
