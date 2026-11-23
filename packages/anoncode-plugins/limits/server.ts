import { Plugin } from "@opencode/plugin"
import { limit } from "./limits"

/** Keeps a shell command the agent waits on from running forever (see `limits.ts`). */
export default Plugin.define({
  id: "anoncode-limits",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool === "shell" || event.tool === "bash") event.input = limit(event.input)
    })
  },
})
