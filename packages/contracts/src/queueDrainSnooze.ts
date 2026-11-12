import * as Schema from "effect/Schema";
import { IsoDateTime, MessageId, NonNegativeInt } from "./baseSchemas.ts";

export const QueueDrainSnooze = Schema.Struct({
  afterSequence: NonNegativeInt,
  requestedAt: IsoDateTime,
  tiedMessageIds: Schema.optional(Schema.Array(MessageId)),
});
