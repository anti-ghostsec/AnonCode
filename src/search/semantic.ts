import type { AgentFS } from "../vfs/types.ts";
import { HashingEmbedder, cosine, type Embedder } from "./embed.ts";

/**
 * Local semantic search over the encrypted project. Files are read from the
 * vault, split into passages, vectorized on-device, and ranked against the
 * query by cosine similarity. Nothing is sent off the machine; the index is
 * built on the fly from the sealed files (no plaintext is persisted).
 */

export type SearchHit = {
  path: string;
  score: number;
  /** 1-based line range of the matching passage. */
  startLine: number;
  endLine: number;
  snippet: string;
};

const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "pdf", "zip", "gz", "tar",
  "exe", "dll", "so", "dylib", "bin", "wasm", "mp3", "mp4", "mov", "woff", "woff2",
]);

/** Split a file into overlapping line windows so matches keep local context. */
export function chunkText(text: string, windowLines = 40, stride = 30): Array<{ startLine: number; endLine: number; text: string }> {
  const lines = text.split("\n");
  if (lines.length <= windowLines) return [{ startLine: 1, endLine: lines.length, text }];
  const chunks: Array<{ startLine: number; endLine: number; text: string }> = [];
  for (let start = 0; start < lines.length; start += stride) {
    const end = Math.min(start + windowLines, lines.length);
    chunks.push({ startLine: start + 1, endLine: end, text: lines.slice(start, end).join("\n") });
    if (end >= lines.length) break;
  }
  return chunks;
}

function isTextPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return !BINARY_EXT.has(ext);
}

export class SemanticSearch {
  constructor(private readonly embedder: Embedder = new HashingEmbedder()) {}

  /** Rank project passages by local similarity to `query`. */
  async search(fs: AgentFS, query: string, k = 8): Promise<SearchHit[]> {
    const q = (await this.embedder.embed([query]))[0]!;
    const passages: Array<{ path: string; startLine: number; endLine: number; text: string }> = [];
    for (const path of fs.paths()) {
      if (!isTextPath(path)) continue;
      const buf = fs.read(path);
      if (!buf) continue;
      // Skip anything that looks binary (NUL in the first KB).
      let binary = false;
      for (let i = 0; i < Math.min(buf.length, 1024); i++) if (buf[i] === 0) { binary = true; break; }
      if (binary) continue;
      const text = buf.toString("utf8");
      for (const c of chunkText(text)) passages.push({ path, ...c });
    }
    if (passages.length === 0) return [];
    const vecs = await this.embedder.embed(passages.map((p) => p.text));
    const scored = passages.map((p, i) => ({ p, score: cosine(q, vecs[i]!) }));
    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter((s) => s.score > 0)
      .slice(0, k)
      .map((s) => ({
        path: s.p.path,
        score: Number(s.score.toFixed(4)),
        startLine: s.p.startLine,
        endLine: s.p.endLine,
        snippet: s.p.text.split("\n").slice(0, 6).join("\n").slice(0, 400),
      }));
  }
}
