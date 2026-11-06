import { type Provider, ProviderError } from "./types.ts";
import type { ProviderConfig } from "../config/config.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAIProvider } from "./openai.ts";
import { MockProvider } from "./mock.ts";

/** Build a live Provider from an (already-decrypted) provider config. */
export function createProvider(config: ProviderConfig): Provider {
  switch (config.kind) {
    case "anthropic":
      if (!config.apiKey) throw new Error("anthropic provider needs an apiKey (run 'anoncode config')");
      return new AnthropicProvider(config.apiKey, config.baseUrl);
    case "openai":
      return new OpenAIProvider(config.apiKey ?? "", config.baseUrl);
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`unknown provider kind: ${(config as ProviderConfig).kind}`);
  }
}

/** A short host label for error messages (never includes any secret). */
function hostOf(config: ProviderConfig): string {
  const url = config.baseUrl ?? (config.kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1");
  try {
    return new URL(url).host;
  } catch {
    return url || config.kind;
  }
}

/**
 * Turn a raw provider failure into a clear, human sentence — so the user sees
 * "The API key was rejected" instead of "HTTP 401: {...}". Never echoes keys.
 */
export function friendlyProviderError(e: unknown, config: ProviderConfig): string {
  const host = hostOf(config);
  if (e instanceof ProviderError) {
    switch (e.kind) {
      case "auth":
        return `The API key was rejected by ${host}. Check that the key is correct and matches the selected provider (an OpenAI key won't work on Anthropic, and vice-versa).`;
      case "bad_request":
        return `${host} rejected the request — usually the model name "${config.model}" isn't valid for this provider. Pick a model this provider offers.`;
      case "rate_limit":
        return `${host} is rate-limiting this key right now. Wait a moment and try again.`;
      case "network":
        return config.baseUrl && /localhost|127\.0\.0\.1/.test(config.baseUrl)
          ? `Couldn't reach ${host}. Make sure your local server (e.g. Ollama / LM Studio) is running.`
          : `Couldn't reach ${host}. Check the base URL and your connection.`;
      default:
        return e.message.replace(/HTTP \d+:\s*/, `${host}: `);
    }
  }
  return (e as Error)?.message ?? "Unknown error";
}

/**
 * List the models a provider actually offers, read live from its API — the
 * OpenAI-compatible `GET /models` endpoint (Venice, OpenRouter, Groq, Ollama,
 * …) or Anthropic's `GET /v1/models`. Returns sorted model ids. Throws a
 * ProviderError on failure so the caller can show a friendly message.
 */
export async function listModels(config: ProviderConfig): Promise<string[]> {
  if (config.kind === "mock") return [config.model].filter(Boolean);
  const headers: Record<string, string> = {};
  let url: string;
  if (config.kind === "anthropic") {
    const base = config.baseUrl ?? "https://api.anthropic.com";
    url = `${base}/v1/models?limit=1000`;
    if (config.apiKey) headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    const base = config.baseUrl ?? "https://api.openai.com/v1";
    url = `${base}/models`;
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  }
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    throw new ProviderError("network", `network error: ${(e as Error).message}`, true);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const kind = res.status === 401 || res.status === 403 ? "auth" : res.status >= 500 ? "network" : "other";
    throw new ProviderError(kind, `HTTP ${res.status}: ${detail.slice(0, 200)}`, false);
  }
  const json = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
  const ids = (json.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string" && x.length > 0);
  return ids.sort((a, b) => a.localeCompare(b));
}

/**
 * Lightweight connectivity + credentials check. Sends one tiny request and
 * reports whether the provider accepts the key and model, with a friendly
 * message on failure. Used by the GUI before saving so misconfiguration is
 * caught at setup, not mid-chat.
 */
export async function probeProvider(config: ProviderConfig): Promise<{ ok: boolean; message?: string }> {
  let provider: Provider;
  try {
    provider = createProvider(config);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  try {
    await provider.generate({
      model: config.model,
      maxTokens: 16,
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: friendlyProviderError(e, config) };
  }
}

export * from "./types.ts";
