import { test, expect } from "bun:test";
import { splitThink, ThinkStream } from "../src/providers/reasoning.ts";

test("splitThink pulls <think> blocks out of the visible answer", () => {
  const r = splitThink("<think>let me reason about this</think>The answer is 42.");
  expect(r.text).toBe("The answer is 42.");
  expect(r.reasoning).toBe("let me reason about this");
});

test("splitThink handles <thinking> and multiple blocks", () => {
  const r = splitThink("<thinking>a</thinking>hi <think>b</think>there");
  expect(r.text).toBe("hi there");
  expect(r.reasoning).toContain("a");
  expect(r.reasoning).toContain("b");
});

test("splitThink treats an unterminated think block as all-reasoning (empty answer)", () => {
  const r = splitThink("<think>I am still thinking and never closed the tag");
  expect(r.text).toBe("");
  expect(r.reasoning).toContain("still thinking");
});

test("plain text with no think tags is returned unchanged", () => {
  const r = splitThink("just a normal answer");
  expect(r.text).toBe("just a normal answer");
  expect(r.reasoning).toBe("");
});

test("ThinkStream separates reasoning from answer across chunk boundaries", () => {
  const s = new ThinkStream();
  let text = "", reasoning = "";
  // Feed the response in awkward chunks, splitting tags down the middle.
  for (const chunk of ["<thi", "nk>reason", "ing part</th", "ink>Final ", "answer"]) {
    const o = s.push(chunk);
    text += o.text; reasoning += o.reasoning;
  }
  const f = s.flush();
  text += f.text; reasoning += f.reasoning;
  expect(text).toBe("Final answer");
  expect(reasoning).toBe("reasoning part");
});

test("ThinkStream never emits a tag fragment as visible text", () => {
  const s = new ThinkStream();
  let text = "";
  for (const chunk of ["Hello ", "<think>x</think>", " world"]) text += s.push(chunk).text;
  text += s.flush().text;
  expect(text).toBe("Hello  world");
  expect(text).not.toContain("<");
});
