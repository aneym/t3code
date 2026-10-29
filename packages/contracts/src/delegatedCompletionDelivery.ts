import * as Schema from "effect/Schema";
import { MessageId, NodeId, PositiveInt, RunId } from "./baseSchemas.ts";

export const OrchestrationV2DelegatedCompletionDelivery = Schema.Struct({
  blockedByRunId: Schema.optional(RunId),
  generation: PositiveInt,
  messageId: MessageId,
  taskIds: Schema.Array(NodeId),
});
export type OrchestrationV2DelegatedCompletionDelivery =
  typeof OrchestrationV2DelegatedCompletionDelivery.Type;

export const OrchestrationV2DelegatedCompletionCohort = Schema.Struct({
  disposition: Schema.Literals(["open", "stopped", "disposed"]),
  nextGeneration: PositiveInt,
  delivery: Schema.NullOr(OrchestrationV2DelegatedCompletionDelivery),
});
export type OrchestrationV2DelegatedCompletionCohort =
  typeof OrchestrationV2DelegatedCompletionCohort.Type;
