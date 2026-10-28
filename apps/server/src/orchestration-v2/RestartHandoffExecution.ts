import { type ServerRestartHandoff, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";

export class RestartHandoffExecutionError extends Schema.TaggedError<RestartHandoffExecutionError>()(
  "RestartHandoffExecutionError",
  { threadId: Schema.String, sourceRunId: Schema.String },
) {}

export const executeRestartHandoff = Effect.fn("RestartHandoffExecution.execute")(
  function* (input: {
    threadId: ThreadId;
    epoch: string;
    handoff: Pick<ServerRestartHandoff, "runIds" | "paused" | "pausedRunIds">;
    humanReply?: string;
  }) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    if (input.handoff.paused) return;
    for (const sourceRunId of input.handoff.runIds) {
      const projection = yield* threads.getThreadProjection(input.threadId);
      const source = projection.runs.find((run) => run.id === sourceRunId);
      if (source === undefined)
        return yield* new RestartHandoffExecutionError({ threadId: input.threadId, sourceRunId });
      if (projection.runs.some((run) => run.restartContinuationOfRunId === sourceRunId)) continue;
      if (
        source.status === "completed" ||
        source.status === "failed" ||
        source.status === "interrupted" ||
        source.status === "rolled_back"
      )
        continue;
      const now = yield* DateTime.now;
      if (
        projection.thread.archivedAt !== null ||
        projection.thread.deletedAt !== null ||
        projection.thread.settledOverride === "settled" ||
        (projection.thread.snoozedUntil != null &&
          DateTime.isGreaterThan(projection.thread.snoozedUntil, now))
      )
        continue;
      if (
        projection.turnItems.some(
          (item) => item.type === "run_interrupt_request" && item.runId === sourceRunId,
        )
      )
        continue;
      const awaitingReview = projection.runtimeRequests.some(
        (request) =>
          request.status === "pending" && request.restartContinuationRunIds?.includes(sourceRunId),
      );
      if (
        input.humanReply === undefined &&
        (input.handoff.pausedRunIds?.includes(sourceRunId) || awaitingReview)
      )
        continue;
      if (
        input.humanReply !== undefined &&
        !projection.runtimeRequests.some(
          (request) =>
            request.status === "resolved" &&
            request.decision !== "decline" &&
            request.decision !== "cancel" &&
            request.restartContinuationRunIds?.includes(sourceRunId) &&
            Object.values(request.answers ?? {}).some(
              (answer) => typeof answer === "string" && answer.trim().length > 0,
            ),
        )
      )
        return yield* new RestartHandoffExecutionError({ threadId: input.threadId, sourceRunId });
      yield* continueRestartedRun({
        threadId: input.threadId,
        sourceRunId,
        prepared: true,
        epoch: input.epoch,
        ...(input.humanReply === undefined ? {} : { humanReply: input.humanReply }),
      });
      const after = yield* threads.getThreadRecords(input.threadId, ["runs"]);
      if (!after.runs.some((run) => run.restartContinuationOfRunId === sourceRunId)) {
        return yield* new RestartHandoffExecutionError({ threadId: input.threadId, sourceRunId });
      }
    }
  },
);
