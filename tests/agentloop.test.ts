import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, type AgentEvent } from "../src/agent/agentloop.ts";
import { AgentLoopError } from "../src/agent/loopguard.ts";
import { parseToolCall } from "../src/agent/toolcall.ts";
import { defaultTools } from "../src/tools/registry.ts";
import type { ToolContext } from "../src/tools/types.ts";
import type { Provider, GenerateResult } from "../src/providers/types.ts";
import type { DiagnosticsProvider } from "../src/tools/diagnostics.ts";
import { MemoryFS } from "../src/vfs/types.ts";
import { Runspace } from "../src/vfs/runspace.ts";

const tmp = mkdtempSync(join(tmpdir(), "anoncode-agent-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function tc(obj: unknown): string {
  return "```tool\n" + JSON.stringify(obj) + "\n```";
}

class ScriptedProvider implements Provider {
  readonly name = "scripted";
  private i = 0;
  constructor(private responses: string[]) {}
  async generate(): Promise<GenerateResult> {
    return { text: this.responses[Math.min(this.i++, this.responses.length - 1)]! };
  }
}

class QueueDiagnostics implements DiagnosticsProvider {
  private i = 0;
  constructor(private q: string[]) {}
  async check(): Promise<string> {
    return this.q[Math.min(this.i++, this.q.length - 1)] ?? "";
  }
}

function ctx(withRunspace = false): ToolContext {
  return {
    fs: new MemoryFS(),
    readFiles: new Set<string>(),
    allow: async () => true,
    runspace: withRunspace ? new Runspace(mkdtempSync(join(tmp, "rs-"))) : undefined,
  };
}

test("parseToolCall reads a fenced tool block and ignores prose", () => {
  expect(parseToolCall("sure, let me look\n" + tc({ tool: "ls", args: {} }))).toEqual({ tool: "ls", args: {} });
  expect(parseToolCall("no tools here, just an answer")).toBeNull();
});

test("agent writes a file, gets diagnostics fed back, fixes it, then finishes", async () => {
  const provider = new ScriptedProvider([
    tc({ tool: "write", args: { path: "gen.ts", content: "const x: number = 'bad';" } }),
    tc({ tool: "write", args: { path: "gen.ts", content: "const x: number = 1;" } }),
    "Done — fixed the type error.",
  ]);
  const diagnostics = new QueueDiagnostics([
    "gen.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
    "", // clean after the fix
  ]);
  const events: AgentEvent[] = [];
  const c = ctx(true);
  const result = await runAgent({
    provider,
    model: "m",
    system: "sys",
    messages: [{ role: "user", content: [{ type: "text", text: "add gen.ts" }] }],
    registry: defaultTools("build"),
    ctx: c,
    diagnostics,
    onEvent: (e) => events.push(e),
  });

  expect(result.finalText).toContain("fixed");
  expect(result.toolCalls).toBe(2);
  // full trace is returned for persistence: 3 assistant turns + 2 tool results
  expect(result.trace.length).toBe(5);
  expect(result.trace.filter((e) => e.kind === "tool_result").length).toBe(2);
  expect(result.trace.at(-1)!.kind).toBe("assistant");
  // the diagnostics were surfaced to the model
  const diag = events.find((e) => e.type === "diagnostics");
  expect(diag && diag.type === "diagnostics" && diag.text).toContain("TS2322");
  // the final (encrypted) file content is the corrected version
  expect(c.fs.read("gen.ts")!.toString()).toContain("number = 1");
});

test("a repeatedly failing tool call trips the loop guard, not an infinite loop", async () => {
  const provider = new ScriptedProvider([
    tc({ tool: "edit", args: { path: "does-not-exist.ts", find: "a", replace: "b" } }),
  ]);
  await expect(
    runAgent({
      provider,
      model: "m",
      system: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      registry: defaultTools("build"),
      ctx: ctx(),
    }),
  ).rejects.toBeInstanceOf(AgentLoopError);
});

test("plan mode exposes no mutating tools", async () => {
  const names = defaultTools("plan").list().map((t) => t.schema.name);
  expect(names).not.toContain("write");
  expect(names).not.toContain("edit");
  expect(names).not.toContain("bash");
  expect(names).toContain("read");
});
