/**
 * On-device text vectorizer for local semantic search.
 *
 * AnonCode's whole premise is that nothing leaves the machine, so we do NOT
 * call a remote embedding API. Instead we build fixed-dimension term vectors
 * with the hashing trick (feature hashing): each token is hashed into one of
 * DIM buckets with a TF weight, and the vector is L2-normalized so cosine
 * similarity is a plain dot product. This is lexical/statistical similarity —
 * an honest local approximation of semantic search, not neural embeddings —
 * but it reads from the encrypted project and sends nothing anywhere.
 *
 * `Embedder` is pluggable: a LOCAL embedding endpoint (e.g. Ollama on
 * 127.0.0.1) can be slotted in later behind the same interface without
 * changing the privacy guarantee.
 */
export interface Embedder {
  readonly dim: number;
  embed(texts: string[]): Promise<Float64Array[]>;
}

const DEFAULT_DIM = 512;

export class HashingEmbedder implements Embedder {
  constructor(readonly dim = DEFAULT_DIM) {}

  async embed(texts: string[]): Promise<Float64Array[]> {
    return texts.map((t) => this.vector(t));
  }

  vector(text: string): Float64Array {
    const v = new Float64Array(this.dim);
    const toks = tokenize(text);
    if (toks.length === 0) return v;
    for (const tok of toks) {
      const h = hash(tok);
      const bucket = h % this.dim;
      // A sign hash reduces collision bias (standard feature-hashing trick).
      const sign = (hash("s:" + tok) & 1) === 0 ? 1 : -1;
      v[bucket] = (v[bucket] ?? 0) + sign;
    }
    // Sublinear TF already implicit via counts; L2-normalize for cosine.
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < v.length; i++) v[i]! /= norm;
    return v;
  }
}

/** Cosine similarity of two L2-normalized vectors (== dot product). */
export function cosine(a: Float64Array, b: Float64Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

function tokenize(text: string): string[] {
  // Code-aware: split camelCase/snake, lowercase, keep identifiers >= 2 chars.
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9_]+/g);
  if (!words) return [];
  const out: string[] = [];
  for (const w of words) {
    for (const part of w.split("_")) if (part.length >= 2) out.push(part);
  }
  return out;
}

/** FNV-1a — small, fast, deterministic string hash. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
