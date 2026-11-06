import { test, expect } from "bun:test";
import { applyReplace, ReplaceError } from "../src/tools/edit-replace.ts";

test("exact unique replacement", () => {
  const r = applyReplace("let a = 1;\nlet b = 2;\n", "let b = 2;", "let b = 3;");
  expect(r.strategy).toBe("exact");
  expect(r.content).toBe("let a = 1;\nlet b = 3;\n");
});

test("ambiguous exact match is refused unless replaceAll", () => {
  expect(() => applyReplace("x\nx\n", "x", "y")).toThrow(ReplaceError);
  const r = applyReplace("x\nx\n", "x", "y", true);
  expect(r.content).toBe("y\ny\n");
  expect(r.count).toBe(2);
});

test("line-trimmed match tolerates trailing whitespace drift", () => {
  const src = "function f() {\n  return 1;   \n}\n"; // trailing spaces in source
  const r = applyReplace(src, "function f() {\n  return 1;\n}", "function f() {\n  return 2;\n}");
  expect(r.strategy).toBe("line-trimmed");
  expect(r.content).toContain("return 2;");
});

test("whitespace-normalized match tolerates indentation drift", () => {
  const src = "if (x) {\n        doThing();\n}\n"; // 8-space indent
  const r = applyReplace(src, "if (x) {\n  doThing();\n}", "if (x) {\n  doOther();\n}");
  expect(["whitespace-normalized", "line-trimmed"]).toContain(r.strategy);
  expect(r.content).toContain("doOther();");
});

test("block-anchor match replaces a drifted interior", () => {
  const src = "START\nmiddle line a\nmiddle line b\nEND\n";
  const r = applyReplace(src, "START\n...different middle...\nEND", "START\nNEW\nEND");
  expect(r.strategy).toBe("block-anchor");
  expect(r.content).toBe("START\nNEW\nEND\n");
});

test("unfindable text throws", () => {
  expect(() => applyReplace("abc", "zzz", "q")).toThrow(ReplaceError);
});
