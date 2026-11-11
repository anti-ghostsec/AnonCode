import { Plugin } from "@opencode/plugin"
import { scrub } from "./scrub"

/**
 * Takes out what tells a model provider the request came from opencode: the `HTTP-Referer` and `X-Title` headers
 * some provider adapters add (OpenRouter, NVIDIA and others), any other header naming opencode, and the user agent,
 * which is replaced with a plain one shared by every AnonCode user.
 */

export default Plugin.define({
  id: "anoncode-privacy",
  async setup(ctx) {
    await ctx.session.hook("http.request", (event) => {
      event.request = new Request(event.request, { headers: scrub(event.request.headers) })
    })
  },
})
