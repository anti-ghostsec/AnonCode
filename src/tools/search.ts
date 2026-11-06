import { type Tool, defineTool, str, cap } from "./types.ts";
import { SemanticSearch } from "../search/semantic.ts";

/**
 * Local semantic search over the encrypted project. Finds relevant passages by
 * on-device similarity (not an exact string match like grep), so a conceptual
 * query ("where is auth handled") surfaces the right code. Read-only, and
 * nothing leaves the machine.
 */
const engine = new SemanticSearch();

export const searchTool: Tool = defineTool(
  {
    name: "search",
    description: "Semantic search over the project: find the passages most relevant to a natural-language query (concepts, not exact strings). Read-only, runs on-device.",
    args: { query: "what to look for (natural language)", k: "max results (optional, default 8)" },
    required: ["query"],
  },
  async (args, ctx) => {
    const query = str(args, "query");
    const k = Math.min(Math.max(Number(args.k ?? 8) || 8, 1), 25);
    const hits = await engine.search(ctx.fs, query, k);
    if (hits.length === 0) return { ok: true, output: "no relevant passages found" };
    const body = hits
      .map((h) => `${h.path}:${h.startLine}-${h.endLine}  (score ${h.score})\n${h.snippet}`)
      .join("\n\n");
    return { ok: true, output: cap(body) };
  },
);
