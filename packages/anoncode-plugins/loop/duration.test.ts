import { expect, test } from "bun:test"
import { duration, takeDuration } from "./duration"
test("durations", () => {
  expect(takeDuration("30m")).toEqual({ minutes: 30, rest: "" })
  expect(takeDuration("2h check the tests")).toEqual({ minutes: 120, rest: "check the tests" })
  expect(takeDuration("1h30m")).toEqual({ minutes: 90, rest: "" })
  expect(takeDuration("1h 30m: tests pass")).toEqual({ minutes: 90, rest: "tests pass" })
  expect(takeDuration("5 hours")).toEqual({ minutes: 300, rest: "" })
  expect(takeDuration("1.5 hours and 10 minutes rules")).toEqual({ minutes: 100, rest: "rules" })
  expect(takeDuration("1 day")).toEqual({ minutes: 1440, rest: "" })
  expect(takeDuration("45")).toEqual({ minutes: 45, rest: "" })
  expect(takeDuration("2 hats")).toEqual({ minutes: 2, rest: "hats" })
  expect(takeDuration("tests pass")).toBeUndefined()
  expect(takeDuration("0h")).toBeUndefined()
  expect(duration(150)).toBe("2 hours 30 minutes")
  expect(duration(1)).toBe("1 minute")
})
