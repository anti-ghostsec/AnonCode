import { createHash } from "node:crypto";
import type { Provider, ProviderMessage, GenerateResult } from "../providers/types.ts";
import { preflightMessages } from "../providers/prepare.ts";
import { DEFAULT_IMAGE_LIMITS, type ProviderImageLimits } from "../media/policy.ts";
import { LoopGuard, DEFAULT_LOOP_GUARD, type LoopGuardOptions } from "./loopguard.ts";
import { parseToolCall, type ToolCall } from "./toolcall.ts";
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
  onEvent?: (e: AgentEvent) => void;
}): Promise<AgentResult> {
  const limits = opts.limits ?? DEFAULT_IMAGE_LIMITS;
  const diagnostics = opts.diagnostics ?? new NoDiagnostics();
  const guard = new LoopGuard(opts.guard ?? DEFAULT_LOOP_GUARD);
  const convo: ProviderMessage[] = [...opts.messages];
  const trace: TraceEntry[] = [];
  let toolCalls = 0;

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
