import * as Schema from "effect/Schema";
import { RunId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const OrchestrationV2RestartCancelledBackgroundWork = Schema.Struct({
  kind: Schema.Literals(["subagent", "shell", "monitor", "task"]),
  label: TrimmedNonEmptyString,
  id: Schema.optional(TrimmedNonEmptyString),
  awaited: Schema.optional(Schema.Literal(true)),
  rearm: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationV2RestartCancelledBackgroundWork =
  typeof OrchestrationV2RestartCancelledBackgroundWork.Type;

export const OrchestrationV2RunBackgroundWorkCancelled = Schema.Struct({
  runId: RunId,
  restartCancelledBackgroundWork: Schema.Array(OrchestrationV2RestartCancelledBackgroundWork),
});
export type OrchestrationV2RunBackgroundWorkCancelled =
  typeof OrchestrationV2RunBackgroundWorkCancelled.Type;
