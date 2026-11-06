import type { Tool, ToolContext, ToolResult } from "./types.ts";
import { readTool, writeTool, editTool, lsTool, globTool, grepTool } from "./fs.ts";
import { bashTool } from "./bash.ts";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const t of tools) this.register(t);
  }

  register(tool: Tool): void {
    this.tools.set(tool.schema.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) return { ok: false, output: `unknown tool: ${name}` };
    return tool.execute(args, ctx);
  }
}

/** The default build toolset. `plan` mode omits the mutating/running tools. */
export function defaultTools(mode: "build" | "plan" = "build"): ToolRegistry {
  if (mode === "plan") return new ToolRegistry([readTool, lsTool, globTool, grepTool]);
  return new ToolRegistry([readTool, writeTool, editTool, lsTool, globTool, grepTool, bashTool]);
}
