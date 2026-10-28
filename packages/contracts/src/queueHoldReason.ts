import * as Schema from "effect/Schema";

export const QueueHoldReason = Schema.Literals(["restart", "stop", "blocked"]);
