import { type ServerRestartHandoff, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { recordRestartDeclined } from "./RestartDecline.ts";
import { restartNoteOwed } from "./RestartBackgroundNote.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";

export class RestartHandoffExecutionError extends Schema.TaggedError<RestartHandoffExecutionError>()(
  "RestartHandoffExecutionError",
  { threadId: Schema.String, sourceRunId: Schema.String },
) {}

export const executeRestartHandoff = Effect.fn("RestartHandoffExecution.execute")(
  function* (input: {
    threadId: ThreadId;
    epoch: string;
    handoff: Pick<ServerRestartHandoff, "runIds" | "pausedRunIds">;
    humanReply?: string;
    willRetry: boolean;
    attempt: number;
  }) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    for (const sourceRunId of input.handoff.runIds) {
      const projection = yield* threads.getThreadProjection(input.threadId);
      const source = projection.runs.find((run) => run.id === sourceRunId);
      if (source === undefined)
        return yield* new RestartHandoffExecutionError({ threadId: input.threadId, sourceRunId });
      if (projection.runs.some((run) => run.restartContinuationOfRunId === sourceRunId)) {
        yield* threads.recoverDelegatedTask(input.threadId, { sourceRunId });
        continue;
      }
      if (
        source.restartDeclined !== undefined ||
        (source.status === "completed" && !restartNoteOwed(source, projection.providerTurns)) ||
        source.status === "failed" ||
        source.status === "interrupted" ||
        source.status === "rolled_back"
      ) {
        yield* threads.recoverDelegatedTask(input.threadId, { sourceRunId });
        continue;
      }
      if (
        projection.thread.archivedAt !== null ||
        projection.thread.deletedAt !== null ||
        projection.thread.settledOverride === "settled"
      ) {
        yield* threads.recoverDelegatedTask(input.threadId, { sourceRunId });
        continue;
      }
      if (
        projection.turnItems.some(
          (item) => item.type === "run_interrupt_request" && item.runId === sourceRunId,
        )
      ) {
        yield* threads.recoverDelegatedTask(input.threadId, { sourceRunId });
        continue;
      }
      const awaitingReview = projection.runtimeRequests.some(
        (request) =>
          request.status === "pending" && request.restartContinuationRunIds?.includes(sourceRunId),
      );
      if (
        input.humanReply === undefined &&
        (input.handoff.pausedRunIds?.includes(sourceRunId) || awaitingReview)
      )
        continue;
      const replyMissing =
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
        );
      const declined = yield* Effect.gen(function* () {
        if (replyMissing)
          return yield* new RestartHandoffExecutionError({ threadId: input.threadId, sourceRunId });
        return yield* continueRestartedRun({
          threadId: input.threadId,
          sourceRunId,
          prepared: true,
          epoch: input.epoch,
          attempt: input.attempt,
          ...(input.humanReply === undefined ? {} : { humanReply: input.humanReply }),
        });
      }).pipe(
        Effect.catch((cause) =>
          input.willRetry ? Effect.fail(cause) : Effect.succeed("dispatch_failed" as const),
        ),
      );
      const after = yield* threads.getThreadRecords(input.threadId, ["runs"]);
      if (after.runs.some((run) => run.restartContinuationOfRunId === sourceRunId)) continue;
      const current = after.runs.find((run) => run.id === sourceRunId);
      if (current === undefined)
        return yield* new RestartHandoffExecutionError({ threadId: input.threadId, sourceRunId });
      yield* recordRestartDeclined(input.threadId, current, declined ?? "dispatch_failed");
      yield* threads.recoverDelegatedTask(input.threadId, { sourceRunId });
    }
  },
);
