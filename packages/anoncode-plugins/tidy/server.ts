import { Plugin } from "@opencode/plugin"
import { tidy } from "./tidy"

/**
 * Takes tool calls a model wrote out as text (see `tidy.ts`) out of what the model is sent back, so it does not take
 * its own markup for something that happened and copy it. The stored conversation is not changed; the interface
 * hides the same markup when it draws a reply.
 */

type Part = { type: string; text?: string }

export default Plugin.define({
  id: "anoncode-tidy",
  async setup(ctx) {
    await ctx.session.hook("context", (event) => {
      for (const message of event.messages as unknown as { role: string; content: string | Part[] }[]) {
        if (message.role !== "assistant") continue
        if (typeof message.content === "string") {
          message.content = tidy(message.content)
          continue
        }
        message.content = message.content.map((part) => (part.type === "text" && part.text ? { ...part, text: tidy(part.text) } : part))
      }
    })
  },
})
