import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listProjects,
  createProject,
  renameProject,
  deleteProject,
  projectPaths,
  getProject,
} from "../src/config/projects.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "anoncode-proj-"));
}

test("a fresh install gets a single non-legacy default project", () => {
  const base = scratch();
  const list = listProjects(base);
  expect(list.length).toBe(1);
  expect(list[0]!.id).toBe("default");
  expect(list[0]!.legacy).toBeUndefined();
  expect(list[0]!.name).toBe("My project");
  rmSync(base, { recursive: true, force: true });
});

test("a pre-existing vault.json is adopted as a legacy default in place (no data moved)", () => {
  const base = scratch();
  writeFileSync(join(base, "vault.json"), "{}");
  const list = listProjects(base);
  expect(list.length).toBe(1);
  expect(list[0]!.legacy).toBe(true);
  expect(list[0]!.name).toBe("Default");
  // Legacy project points at the data-dir root, so the existing vault is reused.
  const paths = projectPaths(list[0]!, base);
  expect(paths.vaultFile).toBe(join(base, "vault.json"));
  expect(paths.dir).toBe(base);
  rmSync(base, { recursive: true, force: true });
});

test("new projects get isolated directories under projects/<id>", () => {
  const base = scratch();
  listProjects(base);
  const p = createProject("Second", base);
  expect(getProject(p.id, base)?.name).toBe("Second");
  const paths = projectPaths(p, base);
  expect(paths.dir).toBe(join(base, "projects", p.id));
  expect(paths.vaultFile).toBe(join(base, "projects", p.id, "vault.json"));
  expect(listProjects(base).length).toBe(2);
  rmSync(base, { recursive: true, force: true });
});

test("rename updates the name; delete removes a project and its data, but not the legacy default", () => {
  const base = scratch();
  writeFileSync(join(base, "vault.json"), "{}"); // legacy default
  const def = listProjects(base)[0]!;
  const p = createProject("Temp", base);
  mkdirSync(projectPaths(p, base).dir, { recursive: true });
  writeFileSync(join(projectPaths(p, base).dir, "vault.json"), "{}");

  renameProject(p.id, "Renamed", base);
  expect(getProject(p.id, base)?.name).toBe("Renamed");

  expect(deleteProject(def.id, base)).toBe(false); // legacy default protected
  expect(deleteProject(p.id, base)).toBe(true);
  expect(getProject(p.id, base)).toBeUndefined();
  expect(existsSync(projectPaths(p, base).dir)).toBe(false);
  expect(listProjects(base).length).toBe(1);
  rmSync(base, { recursive: true, force: true });
});
