/**
 * Tolerant find-and-replace — the core of a good edit tool.
 *
 * Weak models often produce a `find` string that is *almost* right: trailing
 * whitespace differs, indentation is off, a blank line is missing. opencode's
 * edit tool survives this by trying a chain of matchers. AnonCode does the
 * same: exact match first, then progressively more forgiving strategies, each
 * of which must still identify a UNIQUE location (so an edit is never applied
 * to the wrong place). The first strategy that finds exactly one match wins.
 */

export type ReplaceStrategy =
  | "exact"
  | "line-trimmed"
  | "whitespace-normalized"
  | "block-anchor";

export type ReplaceResult = {
  content: string;
  strategy: ReplaceStrategy;
  count: number;
};

export class ReplaceError extends Error {}

export function applyReplace(
  source: string,
  find: string,
  replacement: string,
  replaceAll = false,
): ReplaceResult {
  if (find === "") throw new ReplaceError("find string must not be empty");
  if (find === replacement) throw new ReplaceError("find and replacement are identical");

  // 1. Exact.
  const exact = indicesOf(source, find);
  if (exact.length > 0) {
    if (!replaceAll && exact.length > 1) {
      throw new ReplaceError(
        `found ${exact.length} exact matches; make the find string unique or set replaceAll`,
      );
    }
    return { content: spliceAll(source, find, replacement, exact, replaceAll), strategy: "exact", count: replaceAll ? exact.length : 1 };
  }

  // 2. Line-trimmed: ignore trailing whitespace on each line.
  const lt = matchByLines(source, find, (l) => l.replace(/\s+$/g, ""));
  if (lt) return finishBlock(source, replacement, lt, "line-trimmed");

  // 3. Whitespace-normalized: collapse all runs of whitespace.
  const wn = matchByLines(source, find, (l) => l.replace(/\s+/g, " ").trim());
  if (wn) return finishBlock(source, replacement, wn, "whitespace-normalized");

  // 4. Block-anchor: match on the first and last non-empty lines of the block
  //    and replace everything between (for large blocks the middle may drift).
  const ba = matchByAnchors(source, find);
  if (ba) return finishBlock(source, replacement, ba, "block-anchor");

  throw new ReplaceError("could not locate the find string in the file (even with fuzzy matching)");
}

function indicesOf(hay: string, needle: string): number[] {
  const out: number[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

function spliceAll(source: string, find: string, repl: string, indices: number[], all: boolean): string {
  const use = all ? indices : [indices[0]!];
  let result = "";
  let prev = 0;
  for (const idx of use) {
    result += source.slice(prev, idx) + repl;
    prev = idx + find.length;
  }
  result += source.slice(prev);
  return result;
}

type Range = { start: number; end: number }; // char offsets into source

/** Slide the find block over the source, comparing lines under `norm`. Returns
 * the single matching char range, or null if zero or many matches. */
function matchByLines(source: string, find: string, norm: (l: string) => string): Range | null {
  const srcLines = splitKeepOffsets(source);
  const findLines = find.replace(/\n$/, "").split("\n").map(norm);
  if (findLines.length === 0) return null;
  const matches: Range[] = [];
  for (let i = 0; i + findLines.length <= srcLines.length; i++) {
    let ok = true;
    for (let j = 0; j < findLines.length; j++) {
      if (norm(srcLines[i + j]!.text) !== findLines[j]) { ok = false; break; }
    }
    if (ok) {
      const start = srcLines[i]!.start;
      const last = srcLines[i + findLines.length - 1]!;
      matches.push({ start, end: last.end });
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

/** Match using only the first and last line of the find block as anchors. */
function matchByAnchors(source: string, find: string): Range | null {
  const lines = find.replace(/\n$/, "").split("\n");
  if (lines.length < 3) return null; // too small to anchor safely
  const first = lines[0]!.trim();
  const last = lines[lines.length - 1]!.trim();
  if (first === "" || last === "") return null;
  const srcLines = splitKeepOffsets(source);
  const starts = srcLines.filter((l) => l.text.trim() === first);
  if (starts.length !== 1) return null;
  const startLine = srcLines.indexOf(starts[0]!);
  for (let k = startLine + 1; k < srcLines.length; k++) {
    if (srcLines[k]!.text.trim() === last) {
      return { start: srcLines[startLine]!.start, end: srcLines[k]!.end };
    }
  }
  return null;
}

function finishBlock(source: string, replacement: string, range: Range, strategy: ReplaceStrategy): ReplaceResult {
  const content = source.slice(0, range.start) + replacement + source.slice(range.end);
  return { content, strategy, count: 1 };
}

function splitKeepOffsets(source: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source[i] === "\n") {
      out.push({ text: source.slice(start, i), start, end: i });
      start = i + 1;
      if (i === source.length) break;
    }
  }
  return out;
}
