/**
 * Reasoning / "thinking" extraction.
 *
 * Many models (DeepSeek-R1 and its abliterated derivatives, QwQ, etc.) emit
 * their chain-of-thought either in a separate API field (`reasoning_content`)
 * or inline, wrapped in `<think>…</think>` tags, with the real answer after.
 * If we don't separate it, the thinking leaks into the answer bubble — or, when
 * the model puts *everything* in the think block, the answer looks empty.
 *
 * `splitThink` handles a complete string; `ThinkStream` handles a token stream,
 * tolerating tags that straddle chunk boundaries.
 */

const OPEN = ["<think>", "<thinking>"];
const CLOSE = ["</think>", "</thinking>"];

/** Pull every <think>…</think> block out of `s` into `reasoning`; return the
 * remaining visible text. An unterminated trailing <think> is all reasoning. */
export function splitThink(s: string): { text: string; reasoning: string } {
  let reasoning = "";
  let text = s.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi, (_m, inner: string) => {
    reasoning += (reasoning ? "\n" : "") + inner;
    return "";
  });
  // Unterminated think block: everything after the last opener is reasoning.
  const openMatch = text.match(/<think(?:ing)?>/i);
  if (openMatch && openMatch.index !== undefined) {
    reasoning += (reasoning ? "\n" : "") + text.slice(openMatch.index + openMatch[0].length);
    text = text.slice(0, openMatch.index);
  }
  return { text: text.trim(), reasoning: reasoning.trim() };
}

function earliest(buf: string, tags: string[]): { pos: number; tag: string } {
  let best = -1;
  let bestTag = "";
  for (const t of tags) {
    const i = buf.toLowerCase().indexOf(t);
    if (i !== -1 && (best === -1 || i < best)) {
      best = i;
      bestTag = buf.slice(i, i + t.length); // preserve original case/len
    }
  }
  return { pos: best, tag: bestTag };
}

/** Longest suffix of `buf` that is a proper prefix of one of `tags` — held back
 * so a tag split across chunks isn't mis-emitted as visible text. */
function partialTail(buf: string, tags: string[]): number {
  const lower = buf.toLowerCase();
  let hold = 0;
  for (const t of tags) {
    const max = Math.min(t.length - 1, buf.length);
    for (let n = max; n > 0; n--) {
      if (lower.endsWith(t.slice(0, n))) {
        hold = Math.max(hold, n);
        break;
      }
    }
  }
  return hold;
}

/** Incremental splitter for streamed content. Feed raw content chunks; get back
 * the visible-text and reasoning portions to emit for each chunk. */
export class ThinkStream {
  private buf = "";
  private inThink = false;

  push(chunk: string): { text: string; reasoning: string } {
    this.buf += chunk;
    let text = "";
    let reasoning = "";
    for (;;) {
      if (!this.inThink) {
        const { pos, tag } = earliest(this.buf, OPEN);
        if (pos === -1) {
          const hold = partialTail(this.buf, OPEN);
          text += this.buf.slice(0, this.buf.length - hold);
          this.buf = this.buf.slice(this.buf.length - hold);
          break;
        }
        text += this.buf.slice(0, pos);
        this.buf = this.buf.slice(pos + tag.length);
        this.inThink = true;
      } else {
        const { pos, tag } = earliest(this.buf, CLOSE);
        if (pos === -1) {
          const hold = partialTail(this.buf, CLOSE);
          reasoning += this.buf.slice(0, this.buf.length - hold);
          this.buf = this.buf.slice(this.buf.length - hold);
          break;
        }
        reasoning += this.buf.slice(0, pos);
        this.buf = this.buf.slice(pos + tag.length);
        this.inThink = false;
      }
    }
    return { text, reasoning };
  }

  /** Emit whatever is left when the stream ends. */
  flush(): { text: string; reasoning: string } {
    const rest = this.buf;
    this.buf = "";
    return this.inThink ? { text: "", reasoning: rest } : { text: rest, reasoning: "" };
  }
}
