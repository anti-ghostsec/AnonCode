import { expect, test } from "bun:test"
import { scrub } from "./scrub"

test("takes out what names opencode and keeps the rest", () => {
  const out = scrub(
    new Headers({
      authorization: "Bearer k",
      "HTTP-Referer": "https://opencode.ai/",
      "X-Title": "opencode",
      "user-agent": "opencode/2.2.7 ai-sdk/5",
      "x-client": "opencode-cli",
      "content-type": "application/json",
    }),
  )
  expect(out.get("authorization")).toBe("Bearer k")
  expect(out.get("content-type")).toBe("application/json")
  expect(out.get("http-referer")).toBeNull()
  expect(out.get("x-title")).toBeNull()
  expect(out.get("x-client")).toBeNull()
  expect(out.get("user-agent")).toBe("Mozilla/5.0")
})
