/**
 * Parse a raw stdin chunk (UTF-8 decoded) into a list of key events. Handles
 * the common CSI escape sequences (arrows, home/end, delete, page up/down),
 * control characters, and printable text. Pure and testable.
 */

export type Key = {
  name?:
    | "return"
    | "backspace"
    | "delete"
    | "left"
    | "right"
    | "up"
    | "down"
    | "home"
    | "end"
    | "pageup"
    | "pagedown"
    | "escape"
    | "tab";
  ctrl?: boolean;
  /** The literal character for printable keys. */
  ch?: string;
};

export function parseKeys(input: string): Key[] {
  const chars = [...input];
  const keys: Key[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;

    if (ch === "\x1b") {
      // Escape sequence?
      if (chars[i + 1] === "[" || chars[i + 1] === "O") {
        const { key, consumed } = parseCsi(chars, i);
        if (key) {
          keys.push(key);
          i += consumed - 1;
          continue;
        }
      }
      keys.push({ name: "escape" });
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      keys.push({ name: "return" });
      continue;
    }
    if (ch === "\x7f" || ch === "\b") {
      keys.push({ name: "backspace" });
      continue;
    }
    if (ch === "\t") {
      keys.push({ name: "tab" });
      continue;
    }
    const code = ch.codePointAt(0)!;
    if (code < 0x20) {
      // Control character: map to ctrl+<letter>.
      keys.push({ ctrl: true, ch: String.fromCharCode(code + 96) });
      continue;
    }
    keys.push({ ch });
  }
  return keys;
}

function parseCsi(chars: string[], start: number): { key: Key | null; consumed: number } {
  // chars[start] === ESC, chars[start+1] === '[' or 'O'
  let j = start + 2;
  let params = "";
  while (j < chars.length && /[0-9;]/.test(chars[j]!)) {
    params += chars[j]!;
    j++;
  }
  const final = chars[j];
  const consumed = j - start + 1;
  const map: Record<string, Key> = {
    A: { name: "up" },
    B: { name: "down" },
    C: { name: "right" },
    D: { name: "left" },
    H: { name: "home" },
    F: { name: "end" },
  };
  if (final && map[final]) return { key: map[final]!, consumed };
  if (final === "~") {
    const n: Record<string, Key> = {
      "1": { name: "home" },
      "4": { name: "end" },
      "3": { name: "delete" },
      "5": { name: "pageup" },
      "6": { name: "pagedown" },
      "7": { name: "home" },
      "8": { name: "end" },
    };
    if (n[params]) return { key: n[params]!, consumed };
  }
  return { key: null, consumed };
}
