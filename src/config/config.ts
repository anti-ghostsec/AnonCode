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
  /** Which FOCUS draft model to use: "heuristic" (offline, default — rule-based
   * defensive floor only) or "model" (uses the provider for the paper's
   * Monte-Carlo citation + defensive review; higher fidelity, costs extra
   * model calls when compression triggers). */
  focusDraft?: "heuristic" | "model";
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
  /** Agentic reviewer loop: after each worker turn a reviewer critiques it
   * against the mission and either approves, blocks, or feeds a correction back
   * to the worker (up to maxRounds). Adapted from the opencode loop plugin. */
  reviewer?: {
    enabled?: boolean;
    /** Stable reviewer instruction (what to check for). */
    prompt?: string;
    /** Optional explicit pass/fail criteria (one per line); 'done' needs all. */
    rubric?: string;
    /** Optional mission override; when absent, the user's request is used. */
    mission?: string;
    /** Optional model for the reviewer (same provider); defaults to the worker's. */
    model?: string;
    /** Max worker↔reviewer rounds per turn (1–50, default 4). */
    maxRounds?: number;
  };
  /** Deterministic verifier gate: a check command (tests/build/lint) run after
   * each build turn; on failure its output is fed back to the worker to fix,
   * bounded by the reviewer loop's maxRounds. Complements the reviewer. */
  verifier?: {
    enabled?: boolean;
    /** e.g. "bun test", "bun x tsc --noEmit", "cargo check". */
    command?: string;
  };
  /** Encrypted project memory (Reflexion-style): when enabled (the default),
   * reviewer corrections are distilled into durable lessons and injected into
   * later turns so the agent stops repeating mistakes. */
  memory?: { enabled?: boolean };
  /** Best-of-N: generate N isolated candidates per turn and keep the judge's
   * pick (1 = off, default; max 5). Pairs well with Auto permissions. */
  bestOf?: number;
  /** Use the provider's native function-calling instead of the fenced-text
   * tool protocol, when the provider supports it (default off — the text
   * protocol is the most portable across weak/local models). */
  nativeTools?: boolean;
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
