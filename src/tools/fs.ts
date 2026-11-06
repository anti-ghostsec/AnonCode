import { type Tool, type ToolContext, defineTool, str, cap } from "./types.ts";
import { applyReplace } from "./edit-replace.ts";
import { normVPath } from "../vfs/types.ts";

/**
 * File tools operating on the ENCRYPTED project filesystem (ctx.fs). No project
 * file ever touches the real disk through these — reads decrypt in memory,
 * writes encrypt. When a runspace is active, writes also mirror to it so that
 * `bash`/diagnostics see current files.
 */

const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "pdf", "zip", "gz", "tar",
  "exe", "dll", "so", "dylib", "bin", "wasm", "mp3", "mp4", "mov", "woff", "woff2",
]);

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 1024);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function mirror(ctx: ToolContext, vpath: string, data: Buffer): void {
  ctx.runspace?.put(vpath, data);
}

export const readTool: Tool = defineTool(
  {
    name: "read",
    description: "Read a UTF-8 text file from the encrypted project. Rejects binaries/images. Supports line ranges.",
    args: { path: "file path", offset: "1-based start line (optional)", limit: "max lines (optional)" },
    required: ["path"],
  },
  async (args, ctx) => {
    const vp = normVPath(str(args, "path"));
    const buf = ctx.fs.read(vp);
    if (buf === null) return { ok: false, output: `file not found: ${vp}` };
    const ext = vp.split(".").pop()?.toLowerCase() ?? "";
    if (BINARY_EXT.has(ext)) return { ok: false, output: `refusing to read binary/image file (.${ext})` };
    if (looksBinary(buf)) return { ok: false, output: "refusing to read: file appears to be binary" };
    ctx.readFiles.add(vp);
    let lines = buf.toString("utf8").split("\n");
    const total = lines.length;
    const offset = Math.max(1, Number(args.offset ?? 1));
    const limit = Number(args.limit ?? 2000);
    lines = lines.slice(offset - 1, offset - 1 + limit).map((l) => (l.length > 2000 ? l.slice(0, 2000) + "…" : l));
    const header = total > lines.length ? `[lines ${offset}-${offset + lines.length - 1} of ${total}]\n` : "";
    return { ok: true, output: cap(header + lines.join("\n")) };
  },
);

export const writeTool: Tool = defineTool(
  {
    name: "write",
    description: "Create or overwrite a file in the encrypted project. Overwriting requires reading the file first.",
    args: { path: "file path", content: "full file contents" },
    required: ["path", "content"],
  },
  async (args, ctx) => {
    const vp = normVPath(str(args, "path"));
    if (vp === "") return { ok: false, output: "cannot write to the project root" };
    const content = str(args, "content");
    const exists = ctx.fs.exists(vp);
    if (exists && !ctx.readFiles.has(vp)) {
      return { ok: false, output: `refusing to overwrite ${vp} without reading it first — read it, then write` };
    }
    if (!(await ctx.allow("write", vp))) return { ok: false, output: "write denied by user" };
    ctx.snapshot?.(vp, exists ? ctx.fs.read(vp)?.toString("utf8") ?? null : null);
    const data = Buffer.from(content, "utf8");
    ctx.fs.write(vp, data);
    mirror(ctx, vp, data);
    ctx.readFiles.add(vp);
    return { ok: true, output: `${exists ? "overwrote" : "created"} ${vp} (${content.length} bytes, encrypted)`, changed: [vp] };
  },
);

export const editTool: Tool = defineTool(
  {
    name: "edit",
    description: "Replace text in an existing project file. Must read it first. Tolerant matching; find must be unique unless replaceAll.",
    args: { path: "file path", find: "text to find", replace: "replacement text", replaceAll: "replace all (optional bool)" },
    required: ["path", "find", "replace"],
  },
  async (args, ctx) => {
    const vp = normVPath(str(args, "path"));
    const before = ctx.fs.read(vp);
    if (before === null) return { ok: false, output: `file not found: ${vp}` };
    if (!ctx.readFiles.has(vp)) return { ok: false, output: `read ${vp} before editing it` };
    const find = str(args, "find");
    const replace = str(args, "replace");
    const replaceAll = Boolean(args.replaceAll);
    const beforeText = before.toString("utf8");
    let res;
    try {
      res = applyReplace(beforeText, find, replace, replaceAll);
    } catch (e) {
      return { ok: false, output: `edit failed: ${(e as Error).message}` };
    }
    if (!(await ctx.allow("edit", vp))) return { ok: false, output: "edit denied by user" };
    ctx.snapshot?.(vp, beforeText);
    const data = Buffer.from(res.content, "utf8");
    ctx.fs.write(vp, data);
    mirror(ctx, vp, data);
    return {
      ok: true,
      output: `edited ${vp} (${res.count} replacement${res.count === 1 ? "" : "s"}, match: ${res.strategy})`,
      changed: [vp],
    };
  },
);

export const lsTool: Tool = defineTool(
  {
    name: "ls",
    description: "List the immediate entries under a directory in the encrypted project.",
    args: { path: "directory (optional, defaults to project root)" },
    required: [],
  },
  async (args, ctx) => {
    const vp = normVPath(str(args, "path", false) || "");
    const prefix = vp ? vp + "/" : "";
    const children = new Set<string>();
    for (const p of ctx.fs.paths()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      children.add(slash === -1 ? rest : rest.slice(0, slash) + "/");
    }
    return { ok: true, output: cap([...children].sort().join("\n") || "(empty)") };
  },
);

export const globTool: Tool = defineTool(
  {
    name: "glob",
    description: "Find project files by glob pattern (supports ** and *).",
    args: { pattern: "e.g. **/*.ts" },
    required: ["pattern"],
  },
  async (args, ctx) => {
    const re = globToRegExp(str(args, "pattern"));
    const hits = ctx.fs.paths().filter((p) => re.test(p));
    return { ok: true, output: cap(hits.join("\n") || "(no matches)") };
  },
);

export const grepTool: Tool = defineTool(
  {
    name: "grep",
    description: "Search project file contents with a regular expression. Returns path:line: match.",
    args: { pattern: "regex", glob: "limit to files matching this glob (optional)" },
    required: ["pattern"],
  },
  async (args, ctx) => {
    let re: RegExp;
    try {
      re = new RegExp(str(args, "pattern"));
    } catch (e) {
      return { ok: false, output: `invalid regex: ${(e as Error).message}` };
    }
    const globStr = str(args, "glob", false);
    const fileRe = globStr ? globToRegExp(globStr) : null;
    const out: string[] = [];
    for (const p of ctx.fs.paths()) {
      if (out.length > 500) break;
      if (fileRe && !fileRe.test(p)) continue;
      const buf = ctx.fs.read(p);
      if (!buf || looksBinary(buf)) continue;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) out.push(`${p}:${i + 1}: ${lines[i]!.slice(0, 200)}`);
      }
    }
    return { ok: true, output: cap(out.join("\n") || "(no matches)") };
  },
);

export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("(^|/)" + re + "$");
}
