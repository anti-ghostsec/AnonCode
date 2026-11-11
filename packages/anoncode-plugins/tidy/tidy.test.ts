import { expect, test } from "bun:test"
import { tidy } from "./tidy"

test("takes out a tool call written as text", () => {
  const raw = 'Now the files. <｜DSML｜ calls> <｜DSML｜ invoke name="write"> <｜DSML｜ parameter name="path" string="true">a.py</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls> Done.'
  expect(tidy(raw)).toBe("Now the files. Done.")
})

test("a block cut off runs to the end", () => {
  expect(tidy('Running it. <｜DSML｜ calls> <｜DSML｜ invoke name="shell"> <｜DSML｜ parameter name="command">cd /work && py')).toBe("Running it.")
})

test("other markers and ordinary text", () => {
  expect(tidy("ok<｜end▁of▁sentence｜>")).toBe("ok")
  expect(tidy("a <tag> and | bars")).toBe("a <tag> and | bars")
  expect(tidy("x <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>f<｜tool▁sep｜>{}<｜tool▁call▁end｜><｜tool▁calls▁end｜> y")).toBe("x y")
})
