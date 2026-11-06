import {
  type Provider,
  type GenerateRequest,
  type GenerateResult,
  type ProviderContent,
  type StreamDelta,
  ProviderError,
  type ProviderErrorKind,
} from "./types.ts";
import { splitThink, ThinkStream } from "./reasoning.ts";

/**
 * OpenAI-compatible Chat Completions adapter. Works with the OpenAI API and
 * any compatible gateway, including local servers such as Ollama
 * (baseUrl http://localhost:11434/v1) and LM Studio — useful when you want a
 * fully local, private model with no data leaving the machine at all.
 *
 * The API key comes from the ENCRYPTED config. For keyless local endpoints,
 * pass an empty key.
 */
export class OpenAIProvider implements Provider {
  readonly name = "openai";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const messages: unknown[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) messages.push({ role: m.role, content: m.content.map(toOpenAIPart) });

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: req.model, max_tokens: req.maxTokens ?? 1024, messages }),
      });
    } catch (e) {
      throw new ProviderError("network", `network error: ${(e as Error).message}`, true);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ProviderError(classify(res.status, detail), `HTTP ${res.status}: ${detail.slice(0, 300)}`,
        res.status === 429 || res.status >= 500);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string }>;
    };
    const choice = json.choices?.[0];
    const raw = choice?.message?.content ?? "";
    const apiReasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? "";
    // Some models also inline <think>…</think> in content; pull that out too.
    const split = splitThink(raw);
    const reasoning = [apiReasoning.trim(), split.reasoning].filter(Boolean).join("\n");
    return { text: split.text, reasoning: reasoning || undefined, stopReason: choice?.finish_reason };
  }

  async generateStream(req: GenerateRequest, onDelta: (d: StreamDelta) => void): Promise<GenerateResult> {
    const messages: unknown[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) messages.push({ role: m.role, content: m.content.map(toOpenAIPart) });

    const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: req.model, max_tokens: req.maxTokens ?? 1024, stream: true, messages }),
      });
    } catch (e) {
      throw new ProviderError("network", `network error: ${(e as Error).message}`, true);
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new ProviderError(classify(res.status, detail), `HTTP ${res.status}: ${detail.slice(0, 300)}`,
        res.status === 429 || res.status >= 500);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const think = new ThinkStream();
    let buf = "";
    let text = "";
    let reasoning = "";
    let stopReason: string | undefined;
    const emitContent = (chunk: string) => {
      const part = think.push(chunk);
      if (part.text) { text += part.text; onDelta({ type: "text", text: part.text }); }
      if (part.reasoning) { reasoning += part.reasoning; onDelta({ type: "reasoning", text: part.reasoning }); }
    };
    const emitReasoning = (chunk: string) => { reasoning += chunk; onDelta({ type: "reasoning", text: chunk }); };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let evt: { choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string }> };
        try { evt = JSON.parse(data); } catch { continue; }
        const d = evt.choices?.[0];
        if (d?.delta?.reasoning_content) emitReasoning(d.delta.reasoning_content);
        if (d?.delta?.reasoning) emitReasoning(d.delta.reasoning);
        if (d?.delta?.content) emitContent(d.delta.content);
        if (d?.finish_reason) stopReason = d.finish_reason;
      }
    }
    const tail = think.flush();
    if (tail.text) { text += tail.text; onDelta({ type: "text", text: tail.text }); }
    if (tail.reasoning) { reasoning += tail.reasoning; onDelta({ type: "reasoning", text: tail.reasoning }); }
    return { text: text.trim(), reasoning: reasoning.trim() || undefined, stopReason };
  }
}

function toOpenAIPart(c: ProviderContent): unknown {
  if (c.type === "text") return { type: "text", text: c.text };
  return { type: "image_url", image_url: { url: `data:${c.mime};base64,${c.dataB64}` } };
}

function classify(status: number, detail: string): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 400) {
    const d = detail.toLowerCase();
    if (d.includes("image") && (d.includes("small") || d.includes("dimension") || d.includes("pixel")))
      return "image_too_small";
    if (d.includes("image")) return "image_invalid";
    return "bad_request";
  }
  if (status >= 500) return "network";
  return "other";
}
