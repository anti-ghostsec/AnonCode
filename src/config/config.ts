import type { EncryptedStore } from "../store/store.ts";
import type { ProviderImageLimits } from "../media/policy.ts";
import type { FocusOptions } from "../context/focus.ts";
import type { ServerSpec } from "../lsp/diagnostics.ts";

/**
 * Application config, stored ENCRYPTED in the vault (collection `_config`,
 * record `app`). Provider API keys therefore live sealed on disk, never in a
 * plaintext dotenv file or shell history.
 */

export type ProviderKind = "anthropic" | "openai" | "mock";

export type ProviderConfig = {
  kind: ProviderKind;
  model: string;
  /** Sealed at rest with everything else in the vault. */
  apiKey?: string;
  /** For OpenAI-compatible endpoints (OpenAI, Ollama, local gateways). */
  baseUrl?: string;
};

export type AppConfig = {
  defaultProvider?: string;
  providers: Record<string, ProviderConfig>;
  imageLimits?: Partial<ProviderImageLimits>;
  /** FOCUS context-compression overrides; defaults apply when omitted. */
  focus?: Partial<FocusOptions>;
  /** "build" (default) or "plan" (read-only tools). */
  agentMode?: "build" | "plan";
  /** How tool permissions are handled: "ask" (default — prompt each time) or
   * "auto" (auto-approve, like opencode's auto mode). */
  permissionMode?: "ask" | "auto";
  /** Shell command run after edits; its output is fed back as diagnostics
   * (e.g. "bun x tsc --noEmit", "eslint .", "cargo check"). */
  diagnosticsCommand?: string;
  /** Real LSP diagnostics feedback. Preferred over diagnosticsCommand when enabled. */
  lsp?: { enabled?: boolean; servers?: ServerSpec[] };
};

const COLLECTION = "_config";
const RECORD = "app";

export function loadConfig(store: EncryptedStore): AppConfig {
  return store.getJSON<AppConfig>(COLLECTION, RECORD) ?? { providers: {} };
}

export function saveConfig(store: EncryptedStore, config: AppConfig): void {
  store.putJSON(COLLECTION, RECORD, config);
}

export function setProvider(
  store: EncryptedStore,
  name: string,
  provider: ProviderConfig,
  makeDefault = true,
): AppConfig {
  const config = loadConfig(store);
  config.providers[name] = provider;
  if (makeDefault || !config.defaultProvider) config.defaultProvider = name;
  saveConfig(store, config);
  return config;
}

export function resolveProvider(
  config: AppConfig,
  name?: string,
): { name: string; provider: ProviderConfig } | null {
  const key = name ?? config.defaultProvider;
  if (!key) return null;
  const provider = config.providers[key];
  if (!provider) return null;
  return { name: key, provider };
}
