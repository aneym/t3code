import * as Schema from "effect/Schema";

import { QueueHoldReason } from "./queueHoldReason.ts";

export const ThreadSendDelivery = Schema.Struct({
  delivery: Schema.Literals(["started", "queued", "held", "steered", "restarted"]),
  holdReason: Schema.optional(Schema.NullOr(QueueHoldReason)),
  next: Schema.optional(Schema.String),
});
export type ThreadSendDelivery = typeof ThreadSendDelivery.Type;
