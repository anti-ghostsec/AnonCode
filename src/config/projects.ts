import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./paths.ts";

/**
 * Project registry for the multi-project / tabbed UI.
 *
 * Each project is a fully independent encrypted vault (its own passphrase, its
 * own sealed chats/files/config) living in its own directory — so projects are
 * cryptographically isolated, matching AnonCode's "locked up" model.
 *
 * The index itself (`projects/index.json`) is NOT encrypted: it holds only
 * project ids, display names, and timestamps so the tab bar can render before
 * any vault is unlocked. Names are therefore visible on disk; everything else
 * (chats, files, keys, config) stays sealed. Keep names non-sensitive.
 *
 * A pre-existing single-vault install (`<base>/vault.json`) is adopted as the
 * "default" project IN PLACE — no data is moved, so upgrades are safe.
 *
 * Every function takes the data-dir `base` (default: the real `.anoncode`); the
 * parameter exists so tests can run against a scratch directory.
 */

export type ProjectMeta = {
  id: string;
  name: string;
  createdAt: string;
  /** The adopted legacy vault at the data-dir root (data not moved). */
  legacy?: boolean;
};

export type ProjectPaths = { dir: string; vaultFile: string; runDir: string };

export const PROJECTS_DIR = resolve(DATA_DIR, "projects");

const projectsDir = (base: string) => resolve(base, "projects");
const indexFile = (base: string) => resolve(projectsDir(base), "index.json");
const legacyVault = (base: string) => resolve(base, "vault.json");

function readIndex(base: string): ProjectMeta[] {
  try {
    const list = JSON.parse(readFileSync(indexFile(base), "utf8")) as ProjectMeta[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeIndex(base: string, list: ProjectMeta[]): void {
  mkdirSync(projectsDir(base), { recursive: true });
  writeFileSync(indexFile(base), JSON.stringify(list, null, 2), { mode: 0o600 });
}

/** The project list, always with at least one entry. On first use, a
 * pre-existing `<base>/vault.json` is adopted as a legacy "Default" project in
 * place; otherwise a fresh "My project" entry is created. */
export function listProjects(base: string = DATA_DIR): ProjectMeta[] {
  let list = readIndex(base);
  if (list.length === 0) {
    const legacy = existsSync(legacyVault(base));
    list = [{
      id: "default",
      name: legacy ? "Default" : "My project",
      createdAt: new Date().toISOString(),
      ...(legacy ? { legacy: true } : {}),
    }];
    writeIndex(base, list);
  }
  return list;
}

export function getProject(id: string, base: string = DATA_DIR): ProjectMeta | undefined {
  return listProjects(base).find((p) => p.id === id);
}

export function projectPaths(meta: ProjectMeta, base: string = DATA_DIR): ProjectPaths {
  if (meta.legacy) {
    return { dir: base, vaultFile: legacyVault(base), runDir: resolve(base, "run") };
  }
  const dir = resolve(projectsDir(base), meta.id);
  return { dir, vaultFile: resolve(dir, "vault.json"), runDir: resolve(dir, "run") };
}

export function createProject(name: string, base: string = DATA_DIR): ProjectMeta {
  const list = listProjects(base);
  const id = "p" + randomBytes(5).toString("hex");
  const meta: ProjectMeta = { id, name: (name || "").trim() || "Untitled", createdAt: new Date().toISOString() };
  list.push(meta);
  writeIndex(base, list);
  mkdirSync(projectPaths(meta, base).dir, { recursive: true });
  return meta;
}

export function renameProject(id: string, name: string, base: string = DATA_DIR): ProjectMeta | undefined {
  const list = listProjects(base);
  const m = list.find((p) => p.id === id);
  if (!m) return undefined;
  const n = (name || "").trim();
  if (n) m.name = n;
  writeIndex(base, list);
  return m;
}

/** Permanently delete a project and its encrypted data. Never deletes the
 * adopted legacy default (that would touch the user's original vault tree). */
export function deleteProject(id: string, base: string = DATA_DIR): boolean {
  const list = listProjects(base);
  const m = list.find((p) => p.id === id);
  if (!m || m.legacy) return false;
  try {
    rmSync(projectPaths(m, base).dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  writeIndex(base, list.filter((p) => p.id !== id));
  return true;
}
