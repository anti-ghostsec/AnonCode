import type { ToolRegistry } from "../tools/registry.ts";
import type { AgentFS } from "../vfs/types.ts";

/**
 * Build the agent system prompt. Mirrors what makes opencode effective:
 * explicit tool contract, environment grounding (cwd, platform, date), and the
 * project's own rules file (AGENTS.md / CLAUDE.md) appended verbatim so the
 * model follows local conventions.
 */
export function buildAgentPrompt(opts: {
  fs: AgentFS;
  registry: ToolRegistry;
  mode: "build" | "plan";
  now?: Date;
}): string {
  const { fs, registry, mode } = opts;
  const now = opts.now ?? new Date();

  const toolDocs = registry
    .list()
    .map((t) => {
      const s = t.schema;
      const argList = Object.entries(s.args)
        .map(([k, d]) => `      - ${k}${s.required.includes(k) ? "" : " (optional)"}: ${d}`)
        .join("\n");
      return `  • ${s.name}: ${s.description}\n${argList}`;
    })
    .join("\n");

  const base = `You are AnonCode, a precise terminal coding agent. You help with real code in the user's workspace. This conversation and all files are stored encrypted on the user's machine.

Environment:
  workspace: encrypted project (stored in-vault; files are not on disk)
  platform: ${process.platform}
  date: ${now.toISOString().slice(0, 10)}
  mode: ${mode}${mode === "plan" ? " (read-only: do not modify files or run commands; describe the plan)" : ""}

Working style:
  - Be concise and direct. Prefer doing over explaining.
  - Scale your effort to the task: answer simple or conversational questions
    immediately and briefly with little or no deliberation; reserve extended
    step-by-step reasoning for genuinely hard or multi-step problems.
  - ALWAYS read a file before editing it. Make the smallest change that works.
  - After you edit, you will receive diagnostics (compiler/linter output). Fix
    any errors you introduced before moving on.
  - Do not invent file paths or APIs; use the tools to look.

Tools — to use one, output EXACTLY one fenced block and nothing else:
\`\`\`tool
{"tool": "<name>", "args": { ... }}
\`\`\`
After the tool runs you get its result and continue. When the task is done,
reply normally in prose with NO tool block.

Available tools:
${toolDocs}`;

  const rules = readRules(fs);
  return rules ? `${base}\n\nProject rules (${rules.name}):\n${rules.text}` : base;
}

/** Read the project rules file from the ENCRYPTED project filesystem. */
function readRules(fs: AgentFS): { name: string; text: string } | null {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const buf = fs.read(name);
    if (buf) return { name, text: buf.toString("utf8").slice(0, 8000) };
  }
  return null;
}
