import { createHash } from "node:crypto";
import type { Provider, ProviderMessage, GenerateResult } from "../providers/types.ts";
import { preflightMessages } from "../providers/prepare.ts";
import { DEFAULT_IMAGE_LIMITS, type ProviderImageLimits } from "../media/policy.ts";
import { LoopGuard, DEFAULT_LOOP_GUARD, type LoopGuardOptions } from "./loopguard.ts";
import { parseToolCall, type ToolCall } from "./toolcall.ts";
import type { ProviderTool } from "../providers/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";
import type { DiagnosticsProvider } from "../tools/diagnostics.ts";
import { NoDiagnostics } from "../tools/diagnostics.ts";

/**
 * Multi-step tool-using agent loop.
 *
 * Each step: ask the model, parse a tool call. No tool call -> final answer.
 * A tool call -> execute it; if it edited/wrote files, run diagnostics and
 * append them to the feedback (the opencode-style environment-correction loop);
 * record the outcome with the LoopGuard so repeated identical tool failures
 * stop the agent instead of looping forever.
 */

export type AgentEvent =
  | { type: "assistant"; text: string }
  | { type: "assistant_delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; tool: string; ok: boolean; output: string }
  | { type: "diagnostics"; text: string };

/** One persisted step of the agent's work, so tool context survives between turns. */
export type TraceEntry =
  | { kind: "assistant"; text: string; call?: ToolCall }
  | { kind: "tool_result"; tool: string; ok: boolean; output: string; diagnostics?: string };

export type AgentResult = {
  finalText: string;
  /** Reasoning for the final answer, if the model exposed any (display only). */
  finalReasoning?: string;
  steps: number;
  toolCalls: number;
  /** The full step trace this turn, in order — persist it to keep context. */
  trace: TraceEntry[];
};

export async function runAgent(opts: {
  provider: Provider;
  model: string;
  system: string;
  messages: ProviderMessage[];
  registry: ToolRegistry;
  ctx: ToolContext;
  diagnostics?: DiagnosticsProvider;
  limits?: ProviderImageLimits;
  guard?: LoopGuardOptions;
  maxTokens?: number;
  /** Use the provider's native function-calling when it supports it, instead of
   * the fenced-text tool protocol. Falls back to text when unsupported. */
  nativeTools?: boolean;
  onEvent?: (e: AgentEvent) => void;
}): Promise<AgentResult> {
  const limits = opts.limits ?? DEFAULT_IMAGE_LIMITS;
  const diagnostics = opts.diagnostics ?? new NoDiagnostics();
  const guard = new LoopGuard(opts.guard ?? DEFAULT_LOOP_GUARD);
  const convo: ProviderMessage[] = [...opts.messages];
  const trace: TraceEntry[] = [];
  let toolCalls = 0;

  const useNative = Boolean(opts.nativeTools && opts.provider.supportsNativeTools);
  if (useNative) {
    return runNative({ ...opts, limits, diagnostics, guard, convo, trace });
  }

  for (;;) {
    guard.beginStep();
    const res = await generateOnce(opts.provider, opts.model, opts.system, convo, limits, opts.maxTokens, opts.onEvent);

    const call = parseToolCall(res.text);
    trace.push({ kind: "assistant", text: res.text, call: call ?? undefined });
    if (!call) {
      guard.recordProgress(`final:${hash(res.text)}`);
      return { finalText: res.text, finalReasoning: res.reasoning, steps: guard.stepCount, toolCalls, trace };
    }

    toolCalls++;
    opts.onEvent?.({ type: "tool_call", call });
    convo.push({ role: "assistant", content: [{ type: "text", text: res.text }] });

    let result;
    try {
      result = await opts.registry.execute(call.tool, call.args, opts.ctx);
    } catch (e) {
      result = { ok: false, output: `tool error: ${(e as Error).message}` };
    }
    opts.onEvent?.({ type: "tool_result", tool: call.tool, ok: result.ok, output: result.output });

    let diagText = "";
    if (result.ok && result.changed && result.changed.length > 0 && opts.ctx.runspace) {
      diagText = await diagnostics.check(result.changed, opts.ctx.runspace.dir);
      if (diagText.trim()) opts.onEvent?.({ type: "diagnostics", text: diagText });
    }
    const feedback = `[tool:${call.tool}] ${result.output}` + (diagText.trim() ? `\n\n[diagnostics]\n${diagText}` : "");
    convo.push({ role: "user", content: [{ type: "text", text: feedback }] });
    trace.push({
      kind: "tool_result",
      tool: call.tool,
      ok: result.ok,
      output: result.output,
      diagnostics: diagText.trim() || undefined,
    });

    const sig = `${call.tool}:${hash(JSON.stringify(call.args))}:${result.ok ? "ok" : "err"}`;
    if (result.ok) guard.recordProgress(`tool:${sig}`);
    else guard.recordError(`toolerr:${sig}`, result.output); // trips on repeated identical failure
  }
}

/** Native function-calling loop: the provider returns structured tool calls
 * instead of a fenced-text block, and tool results feed back by call id. The
 * trace it produces is identical in shape to the text path, so persistence and
 * the reviewer evidence summary are unchanged. */
async function runNative(ctx: {
  provider: Provider;
  model: string;
  system: string;
  registry: ToolRegistry;
  ctx: ToolContext;
  diagnostics: DiagnosticsProvider;
  guard: LoopGuard;
  convo: ProviderMessage[];
  trace: TraceEntry[];
  limits: ProviderImageLimits;
  maxTokens?: number;
  onEvent?: (e: AgentEvent) => void;
}): Promise<AgentResult> {
  const { provider, model, system, registry, guard, convo, trace, limits, onEvent } = ctx;
  const tools: ProviderTool[] = registry.list().map(schemaToSpec);
  let toolCalls = 0;

  for (;;) {
    guard.beginStep();
    const pre = preflightMessages(convo, limits);
    const res = await provider.generate({ model, system, messages: pre.messages, maxTokens: ctx.maxTokens, tools });
    if (res.reasoning) onEvent?.({ type: "reasoning", text: res.reasoning });
    if (res.text) onEvent?.({ type: "assistant_delta", text: res.text });

    const calls = res.toolCalls ?? [];
    if (calls.length === 0) {
      trace.push({ kind: "assistant", text: res.text });
      guard.recordProgress(`final:${hash(res.text)}`);
      return { finalText: res.text, finalReasoning: res.reasoning, steps: guard.stepCount, toolCalls, trace };
    }

    // One assistant message carries any prose plus every tool_use this step.
    convo.push({
      role: "assistant",
      content: [
        ...(res.text ? [{ type: "text" as const, text: res.text }] : []),
        ...calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.args })),
      ],
    });

    for (let i = 0; i < calls.length; i++) {
      const c = calls[i]!;
      toolCalls++;
      const call: ToolCall = { tool: c.name, args: c.args };
      onEvent?.({ type: "tool_call", call });
      // Attach the assistant prose to the first call's trace entry only.
      trace.push({ kind: "assistant", text: i === 0 ? res.text : "", call });

      let result;
      try {
        result = await registry.execute(call.tool, call.args, ctx.ctx);
      } catch (e) {
        result = { ok: false, output: `tool error: ${(e as Error).message}` };
      }
      onEvent?.({ type: "tool_result", tool: call.tool, ok: result.ok, output: result.output });

      let diagText = "";
      if (result.ok && result.changed && result.changed.length > 0 && ctx.ctx.runspace) {
        diagText = await ctx.diagnostics.check(result.changed, ctx.ctx.runspace.dir);
        if (diagText.trim()) onEvent?.({ type: "diagnostics", text: diagText });
      }
      const content = `${result.output}` + (diagText.trim() ? `\n\n[diagnostics]\n${diagText}` : "");
      convo.push({ role: "tool", content: [{ type: "tool_result", id: c.id, content, isError: !result.ok }] });
      trace.push({ kind: "tool_result", tool: call.tool, ok: result.ok, output: result.output, diagnostics: diagText.trim() || undefined });

      const sig = `${call.tool}:${hash(JSON.stringify(call.args))}:${result.ok ? "ok" : "err"}`;
      if (result.ok) guard.recordProgress(`tool:${sig}`);
      else guard.recordError(`toolerr:${sig}`, result.output);
    }
  }
}

/** Turn a tool's schema into a JSON-Schema function spec for native calling. */
function schemaToSpec(tool: { schema: { name: string; description: string; args: Record<string, string>; required: string[] } }): ProviderTool {
  const properties: Record<string, unknown> = {};
  for (const [k, desc] of Object.entries(tool.schema.args)) properties[k] = { type: "string", description: desc };
  return {
    name: tool.schema.name,
    description: tool.schema.description,
    parameters: { type: "object", properties, required: tool.schema.required },
  };
}

async function generateOnce(
  provider: Provider,
  model: string,
  system: string,
  messages: ProviderMessage[],
  limits: ProviderImageLimits,
  maxTokens?: number,
  onEvent?: (e: AgentEvent) => void,
): Promise<GenerateResult> {
  const pre = preflightMessages(messages, limits);
  const req = { model, system, messages: pre.messages, maxTokens };
  if (provider.generateStream) {
    return provider.generateStream(req, (d) => {
      if (d.type === "text") onEvent?.({ type: "assistant_delta", text: d.text });
      else onEvent?.({ type: "reasoning", text: d.text });
    });
  }
  // Non-streaming fallback: emit reasoning then text as single deltas so the
  // UI renders them the same way as a streamed response.
  const r = await provider.generate(req);
  if (r.reasoning) onEvent?.({ type: "reasoning", text: r.reasoning });
  if (r.text) onEvent?.({ type: "assistant_delta", text: r.text });
  return r;
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}
