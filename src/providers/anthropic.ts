import {
  type Provider,
  type GenerateRequest,
  type GenerateResult,
  type ProviderContent,
  ProviderError,
  type ProviderErrorKind,
} from "./types.ts";
import { splitThink } from "./reasoning.ts";

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
}

function toAnthropicPart(c: ProviderContent): unknown {
  if (c.type === "text") return { type: "text", text: c.text };
  return {
    type: "image",
    source: { type: "base64", media_type: c.mime, data: c.dataB64 },
  };
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
