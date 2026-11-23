import { expect, test } from "bun:test"
import { limit, MAX_MS } from "./limits"

test("no limit becomes the longest one", () => {
  expect(limit({ command: "python3 serve.py", timeout: 0 })).toEqual({ command: "python3 serve.py", timeout: MAX_MS })
  expect(limit({ command: "x", timeout: 24 * 60 * 60 * 1000 })).toEqual({ command: "x", timeout: MAX_MS })
  expect(limit({ command: "x", timeout: "never" })).toEqual({ command: "x", timeout: MAX_MS })
})

test("the tool's own default and shorter limits stay", () => {
  expect(limit({ command: "ls" })).toEqual({ command: "ls" })
  expect(limit({ command: "cargo build", timeout: 600_000 })).toEqual({ command: "cargo build", timeout: 600_000 })
})

test("background commands are not waited on, so they stay", () => {
  expect(limit({ command: "npm run dev", background: true, timeout: 0 })).toEqual({ command: "npm run dev", background: true, timeout: 0 })
})

test("anything that isn't arguments is left alone", () => {
  expect(limit(null)).toBe(null)
  expect(limit("ls")).toBe("ls")
})
