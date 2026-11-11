/** Time limits for the loop, as people write them. */

const UNIT_MINUTES: Record<string, number> = { d: 1440, day: 1440, days: 1440, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, m: 1, min: 1, mins: 1, minute: 1, minutes: 1 }

/**
 * A duration at the start of `text`: "30m", "2h", "1h30m", "1.5 hours", "5 hours", "1 day", or a bare number of minutes.
 * Returns the minutes and the text after it, or nothing when it does not start with one.
 */
export function takeDuration(text: string): { minutes: number; rest: string } | undefined {
  const pattern = /^\s*(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)?(?![a-z])\s*(?:and\s+)?/i
  let rest = text
  let minutes = 0
  let units = 0
  for (let match = pattern.exec(rest); match; match = pattern.exec(rest)) {
    const unit = match[2]?.toLowerCase()
    // A bare number counts as minutes, but only on its own.
    if (!unit && units > 0) break
    minutes += Number(match[1]) * (unit ? (UNIT_MINUTES[unit] ?? 1) : 1)
    rest = rest.slice(match[0].length)
    units++
    if (!unit) break
  }
  if (units === 0 || !(minutes > 0) || minutes > 60 * 24 * 30) return undefined
  return { minutes: Math.round(minutes * 100) / 100, rest: rest.replace(/^[:;,.-]\s*/, "").trim() }
}

/** "2 hours 30 minutes". */
export function duration(minutes: number) {
  const total = Math.round(minutes)
  const parts = [
    [Math.floor(total / 1440), "day"],
    [Math.floor((total % 1440) / 60), "hour"],
    [total % 60, "minute"],
  ] as const
  const said = parts.filter(([n]) => n > 0).map(([n, unit]) => `${n} ${unit}${n === 1 ? "" : "s"}`)
  return said.length > 0 ? said.join(" ") : "less than a minute"
}
