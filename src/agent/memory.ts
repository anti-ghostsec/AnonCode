import { EncryptedStore, newId } from "../store/store.ts";

/**
 * Per-project encrypted memory — durable lessons the agent accumulates so it
 * stops repeating mistakes across turns and sessions. This is the persistence
 * half of a Reflexion-style loop: the reviewer evaluates a turn, and the
 * correction it issues is distilled into a lesson stored here (sealed in the
 * vault like everything else). On later turns the relevant lessons are injected
 * into the system prompt.
 *
 * Recall is a dependency-free keyword-overlap score (no embeddings) — enough to
 * surface on-topic lessons; semantic recall is a separate, larger feature.
 */

export type MemoryEntry = {
  id: string;
  text: string;
  kind: "lesson" | "fact";
  source: string; // e.g. "reviewer", "user"
  createdAt: string;
};

const COLLECTION = "memory";

export class MemoryStore {
  constructor(private readonly store: EncryptedStore) {}

  list(): MemoryEntry[] {
    return this.store
      .list(COLLECTION)
      .map((id) => this.store.getJSON<MemoryEntry>(COLLECTION, id))
      .filter((m): m is MemoryEntry => m !== null);
  }

  /** Add a lesson, skipping near-duplicates of what's already stored. */
  add(text: string, kind: MemoryEntry["kind"] = "lesson", source = "reviewer"): MemoryEntry | null {
    const clean = text.trim().replace(/\s+/g, " ").slice(0, 500);
    if (clean.length < 4) return null;
    const norm = clean.toLowerCase();
    for (const m of this.list()) if (m.text.toLowerCase() === norm) return null; // exact dup
    const entry: MemoryEntry = { id: newId("mem"), text: clean, kind, source, createdAt: new Date().toISOString() };
    this.store.putJSON(COLLECTION, entry.id, entry);
    return entry;
  }

  remove(id: string): void {
    this.store.remove(COLLECTION, id);
  }

  clear(): void {
    for (const id of this.store.list(COLLECTION)) this.store.remove(COLLECTION, id);
  }

  /**
   * The lessons most relevant to `query`, best first. Scores keyword overlap
   * and always keeps a few most-recent lessons so general guidance still shows.
   */
  relevant(query: string, n = 5): MemoryEntry[] {
    const all = this.list();
    if (all.length <= n) return all;
    const terms = new Set(tokens(query));
    const scored = all.map((m, i) => {
      const t = tokens(m.text);
      let hits = 0;
      for (const w of t) if (terms.has(w)) hits++;
      const overlap = t.length ? hits / Math.sqrt(t.length) : 0;
      return { m, score: overlap + i * 1e-6 /* tiny recency tiebreak */ };
    });
    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, n).map((s) => s.m);
    // Guarantee the single most-recent lesson is present.
    const last = all[all.length - 1]!;
    if (!picked.includes(last)) { picked.pop(); picked.push(last); }
    return picked;
  }
}

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((w) => w.length > 2);
}
