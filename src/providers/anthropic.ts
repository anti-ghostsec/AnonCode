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
 * Anthropic Messages API adapter.
 *
 * Note: the API key is passed in from the ENCRYPTED config — it is never read
 * from a plaintext env file. Errors are normalized to ProviderError kinds so
 * the agent loop can decide whether to remediate, back off, or stop.
 */
export class AnthropicProvider implements Provider {
  readonly name = "anthropic";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.anthropic.com",
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      system: req.system,
      messages: req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content.map(toAnthropicPart) })),
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
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
      content?: Array<{ type: string; text?: string }>;
      stop_reason?: string;
    };
    const text = (json.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const split = splitThink(text);
    return { text: split.text, reasoning: split.reasoning || undefined, stopReason: json.stop_reason };
  }

  async generateStream(req: GenerateRequest, onDelta: (d: StreamDelta) => void): Promise<GenerateResult> {
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      stream: true,
      system: req.system,
      messages: req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content.map(toAnthropicPart) })),
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
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
        // Anthropic SSE carries both `event:` and `data:` lines — we only need
        // the JSON payloads and can key off each event's own `type` field.
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let evt: {
          type?: string;
          delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
        };
        try { evt = JSON.parse(data); } catch { continue; }
        if (evt.type === "content_block_delta") {
          if (evt.delta?.type === "thinking_delta" && evt.delta.thinking) emitReasoning(evt.delta.thinking);
          else if (evt.delta?.type === "text_delta" && evt.delta.text) emitContent(evt.delta.text);
        } else if (evt.type === "message_delta" && evt.delta?.stop_reason) {
          stopReason = evt.delta.stop_reason;
        }
      }
    }
    const tail = think.flush();
    if (tail.text) { text += tail.text; onDelta({ type: "text", text: tail.text }); }
    if (tail.reasoning) { reasoning += tail.reasoning; onDelta({ type: "reasoning", text: tail.reasoning }); }
    return { text: text.trim(), reasoning: reasoning.trim() || undefined, stopReason };
  }
}

function toAnthropicPart(c: ProviderContent): unknown {
  if (c.type === "text") return { type: "text", text: c.text };
  if (c.type === "image") return { type: "image", source: { type: "base64", media_type: c.mime, data: c.dataB64 } };
  if (c.type === "tool_use") return { type: "tool_use", id: c.id, name: c.name, input: c.input };
  // tool_result
  return { type: "tool_result", tool_use_id: c.id, content: c.content, is_error: c.isError };
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
