import { Schema } from "effect"

export const Status = Schema.Literals(["active", "paused", "complete"])
export type Status = typeof Status.Type

export const ModelRef = Schema.Struct({
  providerID: Schema.String,
  id: Schema.String,
  variant: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "AgenticLoop.ModelRef" })
export type ModelRef = typeof ModelRef.Type

export interface State extends Schema.Schema.Type<typeof State> {}
export const State = Schema.Struct({
  id: Schema.String,
  status: Status,
  /** Optional mission override. When absent, `goal` holds the user's request at arm time. */
  task: Schema.optionalKey(Schema.String),
  /** The user request captured when the loop was armed, used to detect goal drift. */
  goal: Schema.optionalKey(Schema.String),
  review: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  /** Reviewer cost reported by its transient child session, in USD. */
  reviewCost: Schema.optionalKey(Schema.Number),
  /** Optional combined session + reviewer cost ceiling, in USD. */
  costLimit: Schema.optionalKey(Schema.Number),
  /** Optional wall-clock limit in minutes. */
  timeLimit: Schema.optionalKey(Schema.Number),
  /** Epoch milliseconds when the time limit expires. */
  deadline: Schema.optionalKey(Schema.Number),
  rounds: Schema.Number,
  maxRounds: Schema.Number,
  stalls: Schema.optionalKey(Schema.Number),
  model: Schema.optionalKey(
    Schema.Struct({
      providerID: Schema.String,
      id: Schema.String,
      variant: Schema.optionalKey(Schema.String),
    }),
  ),
  boot: Schema.String,
  updatedAt: Schema.Number,
}).annotate({ identifier: "AgenticLoop.State" })
