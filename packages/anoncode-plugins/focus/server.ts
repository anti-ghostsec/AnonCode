import { Plugin } from "@opencode/plugin"

/**
 * FOCUS context compression (arXiv:2609.37590), as the first AnonCode adapted it.
 *
 * When a conversation outgrows its budget, whole spans of it (an assistant message with the tool results it
 * produced) are left out of the request. What stays is sent word for word; nothing is summarized. Every user
 * message, every error, the system parts and the most recent spans always stay.
 *
 * The decision is made by the `anoncode focus` program (Rust). This plugin cuts the conversation into spans, asks
 * it which to keep, and removes the rest from the outgoing request. Stored history is never changed: `/focus off`
 * sends everything again.
 *
 * A span that was left out stays out for the rest of the session, so the start of the request does not change from
 * step to step and the provider's prompt cache keeps working.
 */

type Part = { type: string; text?: string; input?: unknown; result?: { type?: string; value?: unknown }; name?: string }
type LlmMessage = { id?: string; role: string; content: string | ReadonlyArray<Part> }
type Span = { id: string; kind: string; text: string; isError: boolean; tokens: number; messages: LlmMessage[] }
type Report = {
  triggered: boolean
  totalTokens: number
  keptTokens: number
  keptCount: number
  droppedCount: number
  kept: string[]
  decisions: { id: string; kind: string; tokens: number; score: number; kept: boolean; reasons: string[] }[]
}
type SessionState = { off: boolean; dropped: string[]; last?: { at: number; total: number; kept: number; dropped: number; budget: number } }

const PREFIX = "session:"
const DEFAULT_SHARE = 0.6
const FALLBACK_BUDGET = 100_000
const KEEP_RECENT = 6

function partText(part: Part) {
  if (part.type === "text" || part.type === "reasoning") return part.text ?? ""
  if (part.type === "tool-call") return `[tool ${part.name ?? ""} ${JSON.stringify(part.input ?? "")}]`
  if (part.type === "tool-result") return typeof part.result?.value === "string" ? part.result.value : JSON.stringify(part.result ?? "")
  return `[${part.type}]`
}

function messageText(message: LlmMessage) {
  return typeof message.content === "string" ? message.content : message.content.map(partText).join("\n")
}

function parts(message: LlmMessage) {
  return typeof message.content === "string" ? [] : message.content
}

/** About four characters a token; images and files count as 1500. */
function estimate(message: LlmMessage) {
  const media = parts(message).filter((part) => part.type === "media").length
  return Math.max(1, Math.ceil(messageText(message).length / 4)) + media * 1500
}

/** An assistant message and the tool results after it are one span, so a call is never sent without its result. */
export function buildSpans(messages: ReadonlyArray<LlmMessage>): Span[] {
  const spans: Span[] = []
  const make = (kind: string, group: LlmMessage[]) => {
    const all = group.flatMap(parts)
    spans.push({
      // A span without a stored id can't be remembered between steps, so it is treated as system and always kept.
      id: group[0].id ?? `unnamed-${spans.length}`,
      kind: group[0].id && !all.some((part) => part.type === "compaction") ? kind : "system",
      text: group.map(messageText).join("\n"),
      isError: all.some((part) => part.type === "tool-result" && /error|denied/i.test(part.result?.type ?? "")),
      tokens: group.reduce((sum, message) => sum + estimate(message), 0),
      messages: group,
    })
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role === "assistant") {
      const group = [message]
      while (messages[i + 1]?.role === "tool") group.push(messages[++i])
      make("assistant", group)
      continue
    }
    if (message.role === "user") make(spans.some((span) => span.kind.startsWith("user")) ? "user" : "user_goal", [message])
    else make(message.role === "system" ? "system" : "tool_result", [message])
  }
  return spans
}

async function decide(request: unknown): Promise<Report | undefined> {
  const bin = process.env.ANONCODE_BIN
  if (!bin) return undefined
  const child = Bun.spawn([bin, "focus"], { stdin: new Blob([JSON.stringify(request)]), stdout: "pipe", stderr: "pipe" })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0) throw new Error(`anoncode focus failed: ${await new Response(child.stderr).text()}`)
  return JSON.parse(out)
}

export default Plugin.define({
  id: "anoncode-focus",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as { budgetTokens?: number; share?: number; keepRecent?: number; tau?: number }
    const sessions = new Map<string, SessionState>()
    const limits = new Map<string, number>()

    const state = async (sessionID: string) => {
      const known = sessions.get(sessionID)
      if (known) return known
      const stored = (await ctx.storage.get(PREFIX + sessionID)) as SessionState | undefined
      const loaded: SessionState = { off: stored?.off === true, dropped: Array.isArray(stored?.dropped) ? stored.dropped : [], last: stored?.last }
      sessions.set(sessionID, loaded)
      return loaded
    }
    const save = (sessionID: string, next: SessionState) => {
      sessions.set(sessionID, next)
      return ctx.storage.set(PREFIX + sessionID, next)
    }

    /** The budget: what the options say, or 60% of the model's context window. */
    const budget = async (model: { providerID: string; id: string }) => {
      // ANONCODE_FOCUS_BUDGET forces a budget, to see compression on a short conversation.
      const forced = Number(process.env.ANONCODE_FOCUS_BUDGET)
      if (forced > 0) return forced
      if (options.budgetTokens) return options.budgetTokens
      const share = Number(process.env.ANONCODE_FOCUS_SHARE) / 100
      const key = `${model.providerID}/${model.id}`
      if (!limits.has(key)) {
        const listed = await ctx.model.list().catch(() => undefined)
        const found = (listed?.data ?? []).find((item) => item.providerID === model.providerID && item.id === model.id)
        const window = found ? Math.min(found.limit.input ?? found.limit.context, found.limit.context) : 0
        limits.set(key, window > 0 ? Math.floor(window * (share > 0 ? share : (options.share ?? DEFAULT_SHARE))) : FALLBACK_BUDGET)
      }
      return limits.get(key) ?? FALLBACK_BUDGET
    }

    // Switched off for every project in AnonCode's Settings.
    const disabled = process.env.ANONCODE_FOCUS === "off"
    await ctx.session.hook("context", async (event) => {
      if (disabled) return
      const current = await state(event.sessionID)
      if (current.off) return
      const spans = buildSpans(event.messages as unknown as LlmMessage[])
      const gone = new Set(current.dropped)
      const live = spans.filter((span) => !gone.has(span.id))
      const limit = await budget(event.model)
      const total = live.reduce((sum, span) => sum + span.tokens, 0)
      const users = live.filter((span) => span.kind.startsWith("user"))
      const report =
        total > limit
          ? await decide({
              spans: live.map((span) => ({ id: span.id, kind: span.kind, text: span.text, isError: span.isError, tokens: span.tokens })),
              task: [users[0]?.text, users.at(-1)?.text].filter(Boolean).join("\n"),
              options: { memoryBudgetTokens: limit, hardCapTokens: limit, keepRecent: options.keepRecent ?? KEEP_RECENT, tau: options.tau ?? 0.3 },
            }).catch((error) => {
              console.warn("[anoncode-focus] left the conversation as it is:", error)
              return undefined
            })
          : undefined
      if (report?.triggered && report.droppedCount > 0) {
        const kept = new Set(report.kept)
        for (const span of live) if (!kept.has(span.id)) gone.add(span.id)
        await save(event.sessionID, {
          off: false,
          dropped: [...gone],
          last: { at: Date.now(), total: report.totalTokens, kept: report.keptTokens, dropped: report.droppedCount, budget: limit },
        })
      }
      if (gone.size === 0) return
      const messages = spans.filter((span) => !gone.has(span.id)).flatMap((span) => span.messages)
      event.messages.splice(0, event.messages.length, ...(messages as unknown as typeof event.messages))
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "focus",
        description: "show what FOCUS context compression left out of this conversation [on|off|reset]",
        execute: async (input) => {
          const current = await state(input.sessionID)
          const word = input.prompt.text.trim().toLowerCase()
          if (word === "off" || word === "on") return void (await save(input.sessionID, { ...current, off: word === "off" }))
          if (word === "reset") return void (await save(input.sessionID, { off: current.off, dropped: [] }))
          const last = current.last
          // A command reports by failing with its text, which the interface shows as a notice.
          throw new Error(
            [
              disabled
                ? "FOCUS is off in AnonCode's Settings: everything is sent."
                : current.off
                  ? "FOCUS is off for this conversation: everything is sent."
                  : "FOCUS is on for this conversation.",
              current.dropped.length === 0
                ? "Nothing has been left out yet."
                : `${current.dropped.length} spans are left out of what the model is sent. They are still in the conversation here.`,
              last
                ? `Last compression: ${last.total.toLocaleString()} tokens down to ${last.kept.toLocaleString()} (budget ${last.budget.toLocaleString()}), ${last.dropped} spans left out, at ${new Date(last.at).toLocaleTimeString()}.`
                : undefined,
              "",
              "/focus off     send the whole conversation again",
              "/focus on      compress when over budget",
              "/focus reset   forget what was left out and decide again",
            ]
              .filter((line) => line !== undefined)
              .join("\n"),
          )
        },
      })
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ["session.deleted"], signal: controller.signal })) {
        sessions.delete(event.data.sessionID)
        await ctx.storage.remove(PREFIX + event.data.sessionID)
      }
    })().catch((error) => {
      if (!controller.signal.aborted) console.error("[anoncode-focus] event stream failed", error)
    })
    return () => controller.abort()
  },
})
