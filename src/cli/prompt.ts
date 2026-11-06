/**
 * Minimal terminal prompts with no dependencies. `promptHidden` reads a line
 * without echoing — used for passphrases so they never appear on screen or in
 * scrollback.
 */

export async function promptLine(question: string): Promise<string> {
  process.stdout.write(question);
  return readLine(false);
}

export async function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const value = await readLine(true);
  process.stdout.write("\n");
  return value;
}

function readLine(hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;
    if (hidden && stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let buf = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          resolve(buf);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl-C
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        if (ch < " ") continue; // ignore other control chars
        buf += ch;
      }
    };

    const cleanup = () => {
      stdin.off("data", onData);
      if (hidden && stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    stdin.on("data", onData);
  });
}
