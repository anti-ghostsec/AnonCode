import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../src/tools/types.ts";
import { readTool, writeTool, editTool, globTool, grepTool } from "../src/tools/fs.ts";
import { bashTool } from "../src/tools/bash.ts";
import { MemoryFS } from "../src/vfs/types.ts";
import { Runspace } from "../src/vfs/runspace.ts";

const tmp = mkdtempSync(join(tmpdir(), "anoncode-tools-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function ctx(allow = true, withRunspace = false): ToolContext {
  return {
    fs: new MemoryFS(),
    readFiles: new Set<string>(),
    allow: async () => allow,
    runspace: withRunspace ? new Runspace(mkdtempSync(join(tmp, "rs-"))) : undefined,
  };
}

test("read marks the file read and returns content", async () => {
  const c = ctx();
  c.fs.write("a.txt", Buffer.from("hello\nworld\n"));
  const r = await readTool.execute({ path: "a.txt" }, c);
  expect(r.ok).toBe(true);
  expect(r.output).toContain("world");
  expect(c.readFiles.has("a.txt")).toBe(true);
});

test("path escape is refused", async () => {
  const r = await readTool.execute({ path: "../../../etc/passwd" }, ctx());
  expect(r.ok).toBe(false);
  expect(r.output).toContain("escapes project root");
});

test("edit requires a prior read (read-before-write)", async () => {
  const c = ctx();
  c.fs.write("b.txt", Buffer.from("foo\n"));
  const denied = await editTool.execute({ path: "b.txt", find: "foo", replace: "bar" }, c);
  expect(denied.ok).toBe(false);
  expect(denied.output).toContain("before editing");
  await readTool.execute({ path: "b.txt" }, c);
  const ok = await editTool.execute({ path: "b.txt", find: "foo", replace: "bar" }, c);
  expect(ok.ok).toBe(true);
  expect(c.fs.read("b.txt")!.toString()).toBe("bar\n");
});

test("write denied when permission says no", async () => {
  const r = await writeTool.execute({ path: "new.txt", content: "x" }, ctx(false));
  expect(r.ok).toBe(false);
  expect(r.output).toContain("denied");
});

test("overwrite requires reading first", async () => {
  const c = ctx();
  c.fs.write("c.txt", Buffer.from("old"));
  const r = await writeTool.execute({ path: "c.txt", content: "new" }, c);
  expect(r.ok).toBe(false);
  expect(r.output).toContain("without reading");
});

test("write mirrors into the runspace when one is active", async () => {
  const c = ctx(true, true);
  const r = await writeTool.execute({ path: "d.txt", content: "mirror me" }, c);
  expect(r.ok).toBe(true);
  // the runspace dir now holds the plaintext mirror
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(join(c.runspace!.dir, "d.txt"), "utf8")).toBe("mirror me");
});

test("glob finds by pattern; grep finds by content", async () => {
  const c = ctx();
  c.fs.write("sub/x.ts", Buffer.from("const secret = 42;\n"));
  const g = await globTool.execute({ pattern: "**/*.ts" }, c);
  expect(g.output).toContain("sub/x.ts");
  const gr = await grepTool.execute({ pattern: "secret = \\d+" }, c);
  expect(gr.output).toContain("sub/x.ts:1");
});

test("bash needs a runspace, is permission-gated, and runs there", async () => {
  const noRun = await bashTool.execute({ command: "echo hi" }, ctx(true, false));
  expect(noRun.ok).toBe(false);
  expect(noRun.output).toContain("no active runspace");

  const denied = await bashTool.execute({ command: "echo hi" }, ctx(false, true));
  expect(denied.ok).toBe(false);

  const ok = await bashTool.execute({ command: "echo hi" }, ctx(true, true));
  expect(ok.ok).toBe(true);
  expect(ok.output).toContain("hi");
});
