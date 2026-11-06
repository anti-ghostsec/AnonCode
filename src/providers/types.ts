/**
 * Provider abstraction. A Provider turns a list of messages into a single
 * assistant reply. Kept intentionally small and non-streaming for now so the
 * agent loop and its loop-guard behavior are easy to test. Streaming can be
 * added behind the same interface later.
 */

export type ProviderContent =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; dataB64: string; filename?: string }
  /** A native tool call the assistant made (function-calling path). */
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  /** The result of a native tool call, linked back by id. */
  | { type: "tool_result"; id: string; content: string; isError?: boolean };

export type ProviderMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: ProviderContent[];
};

/** A tool offered to the model for native function-calling. */
export type ProviderTool = {
  name: string;
  description: string;
  /** JSON-Schema object describing the arguments. */
  parameters: Record<string, unknown>;
};

export type GenerateRequest = {
  model: string;
  messages: ProviderMessage[];
  maxTokens?: number;
  system?: string;
  /** When set, offer these tools for native function-calling. */
  tools?: ProviderTool[];
};

export type GenerateResult = {
  text: string;
  /** Model reasoning / chain-of-thought, when the model or API exposes it
   * (DeepSeek `reasoning_content`, inline `<think>…</think>`, etc.). */
  reasoning?: string;
  /** Native tool calls the model requested this turn (function-calling path). */
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
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
  /** Whether `generate` honors `req.tools` and may return `toolCalls`. */
  readonly supportsNativeTools?: boolean;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** Optional streaming variant. When present, the agent loop uses it so the
   * UI can show tokens (and live reasoning) as they arrive. Implementations
   * must still return the fully-assembled result at the end. */
  generateStream?(req: GenerateRequest, onDelta: (d: StreamDelta) => void): Promise<GenerateResult>;
}
