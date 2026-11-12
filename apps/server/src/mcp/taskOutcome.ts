import {
  OrchestratorMcpFailure,
  type OrchestratorMcpTaskOutcomeInput,
  type OrchestratorMcpTaskOutcomeResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { stableCommandId } from "./stableIds.ts";

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

export const reportTaskOutcome = Effect.fn("TaskOutcome.report")(function* (
  input: OrchestratorMcpTaskOutcomeInput,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const caller = yield* McpInvocationContext.requireThreadScope(scope, "task_outcome");
  const threads = yield* ThreadManagement.ThreadManagementService;
  const { thread, runs } = yield* threads
    .getThreadRecords(caller.thread.threadId, ["runs"])
    .pipe(Effect.mapError(() => failure("thread_not_found", "The calling thread was not found.")));
  if (thread.lineage.relationshipToParent !== "subagent" && thread.delegatedFrom === undefined) {
    return yield* failure(
      "invalid_request",
      "Only a delegated child reports an outcome; this thread has no lead.",
    );
  }
  const run = runs
    .filter(ThreadManagement.isActiveRun)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  if (run === undefined || run.providerInstanceId !== caller.thread.providerInstanceId) {
    return yield* failure("parent_not_active", "No running turn of yours to report on.");
  }
  yield* threads
    .dispatch({
      type: "run.outcome.report",
      commandId: stableCommandId({
        scope,
        operation: "task-outcome",
        requestKey: `${run.id}:${input.outcome}`,
      }),
      threadId: thread.id,
      runId: run.id,
      outcome: input.outcome,
    })
    .pipe(
      Effect.mapError(() => failure("orchestration_error", "Unable to record the task outcome.")),
    );
  return { runId: run.id, outcome: input.outcome } satisfies OrchestratorMcpTaskOutcomeResult;
});
