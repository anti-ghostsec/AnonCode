/** Headers that tell a model provider the request came from opencode, and what replaces them. */

const USER_AGENT = "Mozilla/5.0"
const DROP = new Set(["http-referer", "referer", "x-title", "origin"])

/** The request's headers with the identifying ones taken out. Exported for tests. */
export function scrub(headers: Headers) {
  const clean = new Headers()
  headers.forEach((value, name) => {
    const key = name.toLowerCase()
    if (DROP.has(key) || /opencode|opencode\.ai/i.test(value)) return
    if (key === "user-agent") return
    clean.set(name, value)
  })
  clean.set("user-agent", USER_AGENT)
  return clean
}
