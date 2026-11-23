/**
 * The longest a shell command the agent waits on may run: 15 minutes.
 *
 * The shell tool stops a command after 2 minutes unless the model asks for longer, and a timeout of 0 turns the limit
 * off. With it off, a command that never ends (a script waiting on the network, a server started in the foreground)
 * keeps the agent waiting forever, and the chat with it. Builds and installs get their 15 minutes; past that the
 * command is stopped and the model is told, so it can try another way. Background commands are not waited on, so
 * they are left as the model asked.
 */
export const MAX_MS = 15 * 60 * 1000

/** The shell tool's input with its timeout kept within `MAX_MS`; anything else as it was. */
export function limit(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input
  const args = input as { background?: unknown; timeout?: unknown }
  if (args.background === true) return input
  if (args.timeout === undefined) return input
  if (typeof args.timeout === "number" && args.timeout > 0 && args.timeout <= MAX_MS) return input
  return { ...args, timeout: MAX_MS }
}
