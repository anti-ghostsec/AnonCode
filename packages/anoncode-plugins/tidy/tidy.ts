/**
 * Some models (DeepSeek through some providers) sometimes write a tool call as plain text in their own markup, such
 * as `<｜DSML｜ calls> <｜DSML｜ invoke name="write"> ...`, instead of making the call. The call never runs, and the
 * markup is noise to whoever reads it.
 */

const OPEN = /<｜(?:DSML｜|tool▁calls?▁begin｜|tool▁call▁begin｜)/
const CLOSE = /<\/｜DSML｜[^>]*>|<｜tool▁calls?▁end｜>/g
const STRAY = /<｜(?:end▁of▁sentence|tool▁sep|tool▁call▁end|tool▁outputs?▁(?:begin|end))｜>/g

/** The text without tool calls written out as markup. Exported for tests. */
export function tidy(text: string): string {
  const start = text.search(OPEN)
  if (start === -1) return text.includes("<｜") ? text.replace(STRAY, "") : text
  const rest = text.slice(start)
  // The block ends at its last closing tag; a block cut off (out of steps) runs to the end.
  const ends = [...rest.matchAll(CLOSE)].map((match) => match.index + match[0].length)
  const end = ends.length > 0 ? start + Math.max(...ends) : text.length
  return tidy((text.slice(0, start).trimEnd() + " " + text.slice(end).trimStart()).trim())
}
