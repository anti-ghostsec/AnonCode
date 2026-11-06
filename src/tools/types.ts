import type { AgentFS } from "../vfs/types.ts";
import type { Runspace } from "../vfs/runspace.ts";

/**
 * Tool framework. A Tool takes JSON args and a ToolContext and returns a text
 * result. Tools are the agent's hands — read/write/edit files, run commands,
 * search. File access goes through an encrypted AgentFS (never the raw disk);
 * mutations are gated by a permission callback and a read-before-write rule.
 */

export type ToolResult = {
  ok: boolean;
  /** Text shown back to the model (and, abbreviated, to the user). */
  output: string;
  /** Virtual paths this tool created/modified, for the diagnostics feedback pass. */
  changed?: string[];
};

export type ToolContext = {
  /** Encrypted project filesystem. All project file access goes through this. */
  fs: AgentFS;
  /** Virtual paths read this session — edits require a prior read. */
  readFiles: Set<string>;
  /** Permission gate for side effects. Return false to deny. */
  allow(action: string, detail: string): Promise<boolean>;
  /** Ephemeral plaintext mirror for running commands/diagnostics (if active). */
  runspace?: Runspace;
  /** Optional: snapshot a file's prior content before mutation (for undo). */
  snapshot?: (path: string, prevContent: string | null) => void;
};

export type ToolSchema = {
  name: string;
  description: string;
  /** Arg name -> short description, for the system prompt. */
  args: Record<string, string>;
  required: string[];
};

export interface Tool {
  readonly schema: ToolSchema;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Define a tool whose run function may throw; throws become clean error
 * results so a tool never breaks the agent loop's contract. */
export function defineTool(
  schema: ToolSchema,
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>,
): Tool {
  return {
    schema,
    async execute(args, ctx) {
      try {
        return await run(args, ctx);
      } catch (e) {
        return { ok: false, output: (e as Error).message };
      }
    },
  };
}

export function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new Error(`missing argument: ${key}`);
    return "";
  }
  if (typeof v !== "string") throw new Error(`argument ${key} must be a string`);
  return v;
}

export function cap(text: string, maxChars = 30000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n… [truncated ${text.length - maxChars} chars]`;
}
