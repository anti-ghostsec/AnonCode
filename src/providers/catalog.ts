import type { ProviderKind } from "../config/config.ts";

/**
 * A curated, offline catalog of providers — AnonCode's equivalent of
 * opencode's models.dev list, but static and dependency-free so it works
 * with no network and nothing leaks out just to populate a dropdown.
 *
 * Almost every modern provider speaks the OpenAI Chat Completions protocol, so
 * most presets map to the `openai` engine with a different `baseUrl`. Anthropic
 * has its own wire format and uses the `anthropic` engine.
 *
 * `baseUrl` is the prefix the OpenAI adapter appends `/chat/completions` to
 * (so it already ends in the version segment, e.g. `/v1`). `models` are
 * editable suggestions shown in a datalist — the field stays free text so a
 * new model never requires a code change.
 */
export type ProviderPreset = {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Omitted when the engine's built-in default is correct (Anthropic). */
  baseUrl?: string;
  /** False for local/keyless endpoints (Ollama, LM Studio). */
  needsKey: boolean;
  /** Placeholder shown in the key field. */
  keyHint?: string;
  /** Suggested models (editable). The first is used as the default. */
  models: string[];
  /** Where to get a key, shown as a hint. No link is followed automatically. */
  keysUrl?: string;
  /** Short note shown under the form. */
  note?: string;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    needsKey: true,
    keyHint: "sk-ant-…",
    keysUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-opus-4-8", "claude-sonnet-4-5", "claude-haiku-4-5"],
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
    keyHint: "sk-…",
    keysUrl: "https://platform.openai.com/api-keys",
    models: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
  },
  {
    id: "google",
    label: "Google Gemini",
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
    keyHint: "AIza…",
    keysUrl: "https://aistudio.google.com/apikey",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
  },
  {
    id: "openrouter",
    label: "OpenRouter (many models)",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    keyHint: "sk-or-…",
    keysUrl: "https://openrouter.ai/keys",
    models: [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-4o",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-chat",
    ],
    note: "One key, hundreds of models. Model names are namespaced (vendor/model).",
  },
  {
    id: "groq",
    label: "Groq (fast)",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    needsKey: true,
    keyHint: "gsk_…",
    keysUrl: "https://console.groq.com/keys",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen-2.5-coder-32b"],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    needsKey: true,
    keyHint: "sk-…",
    keysUrl: "https://platform.deepseek.com/api_keys",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "venice",
    label: "Venice AI (private)",
    kind: "openai",
    baseUrl: "https://api.venice.ai/api/v1",
    needsKey: true,
    keyHint: "your Venice API key",
    keysUrl: "https://venice.ai/settings/api",
    models: ["llama-3.3-70b", "qwen3-235b", "qwen-2.5-qwq-32b", "deepseek-r1-671b", "venice-uncensored"],
    note: "Privacy-focused, OpenAI-compatible. Model names are Venice's own (see your Venice dashboard).",
  },
  {
    id: "mistral",
    label: "Mistral",
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    needsKey: true,
    keyHint: "…",
    keysUrl: "https://console.mistral.ai/api-keys",
    models: ["mistral-large-latest", "codestral-latest"],
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    needsKey: true,
    keyHint: "xai-…",
    keysUrl: "https://console.x.ai",
    models: ["grok-2-latest", "grok-2-vision-latest"],
  },
  {
    id: "together",
    label: "Together AI",
    kind: "openai",
    baseUrl: "https://api.together.xyz/v1",
    needsKey: true,
    keyHint: "…",
    keysUrl: "https://api.together.ai/settings/api-keys",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-Coder-32B-Instruct"],
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    kind: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    needsKey: true,
    keyHint: "fw_…",
    keysUrl: "https://fireworks.ai/account/api-keys",
    models: ["accounts/fireworks/models/llama-v3p3-70b-instruct"],
  },
  {
    id: "cerebras",
    label: "Cerebras (fast)",
    kind: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    needsKey: true,
    keyHint: "csk-…",
    keysUrl: "https://cloud.cerebras.ai",
    models: ["llama-3.3-70b", "qwen-3-coder-480b"],
  },
  {
    id: "ollama",
    label: "Ollama (local, private)",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    models: ["qwen2.5-coder", "llama3.1", "deepseek-coder-v2"],
    note: "Runs fully on your machine — nothing leaves it. Start Ollama first (ollama serve).",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local, private)",
    kind: "openai",
    baseUrl: "http://localhost:1234/v1",
    needsKey: false,
    models: ["local-model"],
    note: "Runs fully on your machine. Start the LM Studio local server first.",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    kind: "openai",
    baseUrl: "",
    needsKey: false,
    models: [],
    note: "Any OpenAI-compatible endpoint. Enter its base URL (ending in /v1) and model.",
  },
];

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
