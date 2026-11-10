import { Rpc } from "@opencode/plugin"
import { Schema } from "effect"
import { ModelRef, State } from "./state"

export type { State } from "./state"

const Control = Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String }))
const Nothing = Schema.toStandardSchemaV1(Schema.Null)

export const Definition = Rpc.define({
  id: "agentic.loop",
  methods: {
    get: {
      input: Control,
      output: Schema.toStandardSchemaV1(Schema.NullOr(State)),
    },
    start: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: Schema.String,
          task: Schema.optionalKey(Schema.String),
          review: Schema.optionalKey(Schema.String),
          model: Schema.optionalKey(ModelRef),
          costLimit: Schema.optionalKey(Schema.Number),
          timeLimit: Schema.optionalKey(Schema.Number),
        }),
      ),
      output: Nothing,
    },
    note: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String, text: Schema.String })),
      output: Nothing,
    },
    pause: { input: Control, output: Nothing },
    resume: { input: Control, output: Nothing },
    clear: { input: Control, output: Nothing },
  },
  events: {
    changed: {
      schema: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String, loop: Schema.NullOr(State) })),
    },
  },
})
