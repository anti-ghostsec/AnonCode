/**
 * Zero-dependency ANSI terminal helpers: escape sequences, colors (NO_COLOR
 * aware), and ANSI-aware text layout (visible length, wrap, pad, truncate).
 * Kept pure so it can be unit-tested without a terminal.
 */

const ESC = "\x1b[";

export const seq = {
  home: ESC + "H",
  clearScreen: ESC + "2J",
  clearLine: ESC + "K",
  clearBelow: ESC + "J",
  hideCursor: ESC + "?25l",
  showCursor: ESC + "?25h",
  altScreen: ESC + "?1049h",
  mainScreen: ESC + "?1049l",
  moveTo: (row: number, col: number) => `${ESC}${row};${col}H`,
};

export function colorize(enabled: boolean, code: string, s: string): string {
  return enabled ? `${ESC}${code}m${s}${ESC}0m` : s;
}

/** Color palette bound to an enabled flag (so tests can force it off). */
export function palette(enabled: boolean) {
  const w = (code: string) => (s: string) => colorize(enabled, code, s);
  return {
    dim: w("2"),
    bold: w("1"),
    red: w("31"),
    green: w("32"),
    yellow: w("33"),
    blue: w("34"),
    magenta: w("35"),
    cyan: w("36"),
    gray: w("90"),
  };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function visLen(s: string): number {
  return [...stripAnsi(s)].length;
}

/** Pad a (possibly colored) string to `width` visible columns. */
export function padEnd(s: string, width: number): string {
  const len = visLen(s);
  return len >= width ? s : s + " ".repeat(width - len);
}

/** Truncate to `width` visible columns, dropping color codes if we must cut. */
export function truncate(s: string, width: number): string {
  if (visLen(s) <= width) return s;
  const plain = stripAnsi(s);
  return [...plain].slice(0, Math.max(0, width - 1)).join("") + "…";
}

/** Word-wrap text to `width`, honoring explicit newlines and hard-splitting
 * words longer than the width. */
export function wrapText(text: string, width: number): string[] {
  if (width < 1) return [text];
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      if (word === "") continue;
      if (visLen(line) + visLen(word) <= width) {
        line += word;
      } else if (/^\s+$/.test(word)) {
        // trailing space that would overflow — ignore
      } else if (visLen(word) > width) {
        if (line.trim()) out.push(line.trimEnd());
        let w = word;
        while (visLen(w) > width) {
          out.push([...w].slice(0, width).join(""));
          w = [...w].slice(width).join("");
        }
        line = w;
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}
