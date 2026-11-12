import * as Schema from "effect/Schema";
import { RunId } from "./baseSchemas.ts";
import { ReportedOutcomeFields } from "./delegatedTaskOutcome.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";

/** With untilDelegatedWorkSettled, once settled: the run whose reply is the thread's result. */
export const ThreadWaitResultRun = Schema.Struct({
  runId: RunId,
  status: OrchestrationV2RunStatus,
  ...ReportedOutcomeFields,
});
