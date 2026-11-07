import * as Schema from "effect/Schema";
import { OrchestrationV2ProviderFailureClass } from "./providerFailureClass.ts";

export const QueueHoldReason = Schema.Literals(["restart", "stop", "blocked"]);

export const QueueHoldState = Schema.Struct({
  queueHeld: Schema.optional(Schema.Boolean),
  queueHoldReason: Schema.optional(QueueHoldReason),
  queueHeldAt: Schema.optional(Schema.DateTimeUtc),
  queueHoldFailureClass: Schema.optional(OrchestrationV2ProviderFailureClass),
});

export const QueueHoldStateJson = QueueHoldState.mapFields((fields) => ({
  ...fields,
  queueHeldAt: Schema.optional(Schema.DateTimeUtcFromString),
}));
