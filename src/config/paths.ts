import { resolve } from "node:path";

// The AnonCode project root. Everything AnonCode reads or writes at runtime
// lives UNDER this directory. Nothing is ever written outside of it
// (no ~/.config, no ~/.local/share, no /tmp).
export const ROOT = resolve(import.meta.dir, "..", "..");

// All runtime data lives here. The whole directory is gitignored and every
// file inside it is encrypted at rest (see src/crypto + src/store).
export const DATA_DIR = resolve(ROOT, ".anoncode");

// Vault header: KDF parameters + salt + a passphrase verifier. Contains no
// secret material on its own — the master key is never written to disk.
export const VAULT_FILE = resolve(DATA_DIR, "vault.json");

// Encrypted collections.
export const SESSIONS_DIR = resolve(DATA_DIR, "sessions");
export const FILES_DIR = resolve(DATA_DIR, "files");

// Ephemeral plaintext mirror for running commands/diagnostics. Lives inside
// the AnonCode folder and is wiped when a session ends.
export const RUN_DIR = resolve(DATA_DIR, "run");

// Non-secret local config (model/provider selection, UI prefs). No secrets.
export const CONFIG_FILE = resolve(DATA_DIR, "config.json");

/**
 * Guard against path escapes. Returns the resolved absolute path only if it
 * stays within `root`; throws otherwise. Used everywhere a caller-supplied
 * name is joined onto a base directory.
 */
export function within(root: string, ...parts: string[]): string {
  const p = resolve(root, ...parts);
  const base = root.endsWith("/") ? root : root + "/";
  if (p !== root && !p.startsWith(base)) {
    throw new Error(`path escapes allowed root: ${p}`);
  }
  return p;
}
