import * as Schema from "effect/Schema";

export const QueueHoldReason = Schema.Literals(["restart", "stop", "blocked"]);

export const QueueHoldState = Schema.Struct({
  queueHeld: Schema.optional(Schema.Boolean),
  queueHoldReason: Schema.optional(QueueHoldReason),
  queueHeldAt: Schema.optional(Schema.DateTimeUtc),
});

export const QueueHoldStateJson = QueueHoldState.mapFields((fields) => ({
  ...fields,
  queueHeldAt: Schema.optional(Schema.DateTimeUtcFromString),
}));
