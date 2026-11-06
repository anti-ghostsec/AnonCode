import { test, expect } from "bun:test";
import { runAgent } from "../src/agent/agentloop.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { defineTool } from "../src/tools/types.ts";
import type { Provider, GenerateRequest, GenerateResult } from "../src/providers/types.ts";
import { MemoryFS } from "../src/vfs/types.ts";
import type { ToolContext } from "../src/tools/types.ts";

// A tool that records its calls so we can assert native dispatch worked.
function recordingTool(log: Array<{ args: Record<string, unknown> }>) {
  return defineTool(
    { name: "note", description: "record a note", args: { text: "the note" }, required: ["text"] },
    async (args) => { log.push({ args }); return { ok: true, output: "noted" }; },
  );
}

// Scripted native provider: first turn returns a tool_call, then a final answer.
class NativeProvider implements Provider {
  readonly name = "native-mock";
  readonly supportsNativeTools = true;
  private step = 0;
  sawTools = false;
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (req.tools?.length) this.sawTools = true;
    this.step++;
    if (this.step === 1) {
      return { text: "", toolCalls: [{ id: "call_1", name: "note", args: { text: "hello" } }] };
    }
    return { text: "all done" };
  }
}

function ctx(): ToolContext {
  return { fs: new MemoryFS(), readFiles: new Set<string>(), allow: async () => true };
}

test("native tool-calling dispatches a structured call and returns the final answer", async () => {
  const log: Array<{ args: Record<string, unknown> }> = [];
  const registry = new ToolRegistry([recordingTool(log)]);
  const provider = new NativeProvider();
  const result = await runAgent({
    provider, model: "m", system: "sys",
    messages: [{ role: "user", content: [{ type: "text", text: "take a note" }] }],
    registry, ctx: ctx(), nativeTools: true,
  });
  expect(provider.sawTools).toBe(true); // tool specs were offered to the model
  expect(log.length).toBe(1);
  expect(log[0]!.args.text).toBe("hello"); // structured args flowed through
  expect(result.finalText).toBe("all done");
  expect(result.toolCalls).toBe(1);
  // Trace shape matches the text path: an assistant+call entry and a tool_result.
  expect(result.trace.some((e) => e.kind === "assistant" && e.call?.tool === "note")).toBe(true);
  expect(result.trace.some((e) => e.kind === "tool_result" && e.tool === "note")).toBe(true);
});

test("nativeTools falls back to the text protocol when the provider lacks support", async () => {
  // A text-only provider that emits a fenced tool block, then a final answer.
  let step = 0;
  const provider: Provider = {
    name: "text-mock",
    async generate() {
      step++;
      if (step === 1) return { text: '```tool\n{"tool":"note","args":{"text":"hi"}}\n```' };
      return { text: "finished" };
    },
  };
  const log: Array<{ args: Record<string, unknown> }> = [];
  const registry = new ToolRegistry([recordingTool(log)]);
  const result = await runAgent({
    provider, model: "m", system: "s",
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    registry, ctx: ctx(), nativeTools: true, // requested, but provider has no native support
  });
  expect(log.length).toBe(1);
  expect(result.finalText).toBe("finished");
});
