import { palette, wrapText } from "./ansi.ts";

/**
 * The conversation as display blocks, wrapped to a width with per-role styling.
 * Pure: `render(width, color)` returns the full list of screen lines.
 */

export type BlockRole = "user" | "assistant" | "tool" | "note" | "diag" | "error";

export type Block = { role: BlockRole; text: string };

const LABEL: Record<BlockRole, string> = {
  user: "you",
  assistant: "ai",
  tool: " ·",
  note: " ·",
  diag: " ⚠",
  error: " !",
};

export class Transcript {
  readonly blocks: Block[] = [];

  add(role: BlockRole, text: string): void {
    this.blocks.push({ role, text });
  }

  render(width: number, color = true): string[] {
    const c = palette(color);
    const paint: Record<BlockRole, (s: string) => string> = {
      user: c.cyan,
      assistant: c.green,
      tool: c.gray,
      note: c.gray,
      diag: c.yellow,
      error: c.red,
    };
    const lines: string[] = [];
    for (const b of this.blocks) {
      const label = b.role === "user" ? c.bold(c.cyan("you ›")) : b.role === "assistant" ? c.bold(c.green("ai  ›")) : paint[b.role](LABEL[b.role]);
      const body = wrapText(b.text, Math.max(10, width - 6));
      body.forEach((ln, i) => {
        const gutter = i === 0 ? label : "     ";
        lines.push(`${gutter} ${b.role === "user" || b.role === "assistant" ? ln : paint[b.role](ln)}`);
      });
      if (b.role === "assistant") lines.push(""); // breathing room after answers
    }
    return lines;
  }
}
