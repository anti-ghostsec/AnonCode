import { spawn } from "node:child_process";
import { type Tool, defineTool, str, cap } from "./types.ts";

/**
 * Run a shell command in the workspace. Permission-gated: the agent cannot run
 * anything without the user's `allow` callback saying yes. Output (stdout +
 * stderr) is captured and capped; a timeout kills runaway commands.
 */
export const bashTool: Tool = defineTool(
  {
    name: "bash",
    description: "Run a shell command in the workspace root. Requires permission. Returns combined stdout+stderr and the exit code.",
    args: { command: "the shell command", timeout: "ms before kill (optional, default 120000)" },
    required: ["command"],
  },
  async (args, ctx) => {
    const command = str(args, "command");
    const timeout = Math.min(Number(args.timeout ?? 120000) || 120000, 600000);
    if (!ctx.runspace) {
      return { ok: false, output: "no active runspace — commands can only run inside a chat session" };
    }
    if (!(await ctx.allow("bash", command))) {
      return { ok: false, output: "command denied by user" };
    }
    const { code, out } = await runShell(command, ctx.runspace.dir, timeout);
    // Re-encrypt any files the command created/changed back into the project.
    const changed = ctx.runspace.syncBack(ctx.fs);
    const status = code === 124 ? "timed out" : `exit ${code}`;
    const note = changed.length ? `\n[captured ${changed.length} changed file(s) into the encrypted project]` : "";
    return { ok: code === 0, output: cap(`[${status}]\n${out}${note}`), changed };
  },
);

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd });
    let out = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, out: out + `\n[spawn error] ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: killed ? 124 : code ?? 0, out });
    });
  });
}
