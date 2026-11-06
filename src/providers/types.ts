/**
 * Provider abstraction. A Provider turns a list of messages into a single
 * assistant reply. Kept intentionally small and non-streaming for now so the
 * agent loop and its loop-guard behavior are easy to test. Streaming can be
 * added behind the same interface later.
 */

export type ProviderContent =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; dataB64: string; filename?: string };

export type ProviderMessage = {
  role: "system" | "user" | "assistant";
  content: ProviderContent[];
};

export type GenerateRequest = {
  model: string;
  messages: ProviderMessage[];
  maxTokens?: number;
  system?: string;
};

export type GenerateResult = {
  text: string;
  /** Model reasoning / chain-of-thought, when the model or API exposes it
   * (DeepSeek `reasoning_content`, inline `<think>…</think>`, etc.). */
  reasoning?: string;
  stopReason?: string;
};

/** A streamed piece of a response: visible answer text or hidden reasoning. */
export type StreamDelta =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string };

/** Normalized failure kinds so the agent loop can decide how to react. */
export type ProviderErrorKind =
  | "image_too_small"
  | "image_invalid"
  | "rate_limit"
  | "auth"
  | "network"
  | "bad_request"
  | "other";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    /** Whether a plain retry (same payload) could ever succeed. */
    readonly retriable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface Provider {
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** Optional streaming variant. When present, the agent loop uses it so the
   * UI can show tokens (and live reasoning) as they arrive. Implementations
   * must still return the fully-assembled result at the end. */
  generateStream?(req: GenerateRequest, onDelta: (d: StreamDelta) => void): Promise<GenerateResult>;
}
