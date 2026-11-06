import { test, expect } from "bun:test";
import { stripAnsi, visLen, wrapText, truncate, padEnd, colorize } from "../src/tui/ansi.ts";
import { parseKeys } from "../src/tui/keys.ts";
import { LineEditor } from "../src/tui/lineeditor.ts";
import { Transcript } from "../src/tui/transcript.ts";

// ---- ansi -----------------------------------------------------------------

test("visLen and stripAnsi ignore color codes", () => {
  const s = colorize(true, "31", "red");
  expect(stripAnsi(s)).toBe("red");
  expect(visLen(s)).toBe(3);
});

test("colorize is a no-op when disabled", () => {
  expect(colorize(false, "31", "x")).toBe("x");
});

test("wrapText wraps on words and hard-splits long words", () => {
  expect(wrapText("the quick brown fox", 9)).toEqual(["the quick", "brown fox"]);
  expect(wrapText("supercalifragilistic", 5)).toEqual(["super", "calif", "ragil", "istic"]);
  expect(wrapText("a\nb", 10)).toEqual(["a", "b"]);
});

test("truncate and padEnd respect visible width", () => {
  expect(truncate("hello world", 8)).toBe("hello w…");
  expect(visLen(padEnd("hi", 5))).toBe(5);
});

// ---- keys -----------------------------------------------------------------

test("parses arrows, enter, backspace, ctrl, and printable chars", () => {
  expect(parseKeys("\x1b[A")).toEqual([{ name: "up" }]);
  expect(parseKeys("\x1b[3~")).toEqual([{ name: "delete" }]);
  expect(parseKeys("\r")).toEqual([{ name: "return" }]);
  expect(parseKeys("\x7f")).toEqual([{ name: "backspace" }]);
  expect(parseKeys("\x03")).toEqual([{ ctrl: true, ch: "c" }]);
  expect(parseKeys("hi")).toEqual([{ ch: "h" }, { ch: "i" }]);
});

test("parses a pasted mix in one chunk", () => {
  const keys = parseKeys("ab\x1b[Dc");
  expect(keys).toEqual([{ ch: "a" }, { ch: "b" }, { name: "left" }, { ch: "c" }]);
});

// ---- line editor ----------------------------------------------------------

function type(ed: LineEditor, s: string) {
  for (const k of parseKeys(s)) ed.apply(k);
}

test("edits text with cursor movement and backspace", () => {
  const ed = new LineEditor();
  type(ed, "helo");
  type(ed, "\x1b[D"); // left (between l and o)
  type(ed, "l"); // insert -> "hello"
  expect(ed.value()).toBe("hello");
  type(ed, "\x7f"); // backspace -> "helo"
  expect(ed.value()).toBe("helo");
});

test("enter submits and records history; up recalls it", () => {
  const ed = new LineEditor();
  type(ed, "first");
  expect(ed.apply(parseKeys("\r")[0]!)).toBe("submit");
  ed.reset();
  ed.apply(parseKeys("\x1b[A")[0]!); // up
  expect(ed.value()).toBe("first");
});

test("ctrl-c cancels", () => {
  const ed = new LineEditor();
  expect(ed.apply(parseKeys("\x03")[0]!)).toBe("cancel");
});

// ---- transcript -----------------------------------------------------------

test("transcript renders labelled, wrapped lines", () => {
  const t = new Transcript();
  t.add("user", "hello there");
  t.add("assistant", "hi");
  const lines = t.render(40, false); // color off for stable assertions
  expect(lines[0]).toContain("you ›");
  expect(lines[0]).toContain("hello there");
  expect(lines.some((l) => l.includes("ai  ›") && l.includes("hi"))).toBe(true);
});
