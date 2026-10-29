import {
  type OrchestrationV2DomainEvent,
  type ServerRestartHandoff,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EventSink from "./EventSink.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
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
  }) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    for (const sourceRunId of input.handoff.runIds) {
      const projection = yield* threads.getThreadProjection(input.threadId);
      const source = projection.runs.find((run) => run.id === sourceRunId);
      if (source === undefined)
        return yield* new RestartHandoffExecutionError({ threadId: input.threadId, sourceRunId });
      if (
        projection.runs.some((run) => run.restartContinuationOfRunId === sourceRunId) ||
        source.restartDeclined !== undefined
      )
        continue;
      if (
        (source.status === "completed" && !restartNoteOwed(source, projection.providerTurns)) ||
        source.status === "failed" ||
        source.status === "interrupted" ||
        source.status === "rolled_back"
      )
        continue;
      if (
        projection.thread.archivedAt !== null ||
        projection.thread.deletedAt !== null ||
        projection.thread.settledOverride === "settled"
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
      const declined = yield* continueRestartedRun({
        threadId: input.threadId,
        sourceRunId,
        prepared: true,
        epoch: input.epoch,
        ...(input.humanReply === undefined ? {} : { humanReply: input.humanReply }),
      });
      const after = yield* threads.getThreadRecords(input.threadId, ["runs"]);
      if (after.runs.some((run) => run.restartContinuationOfRunId === sourceRunId)) continue;
      const current = after.runs.find((run) => run.id === sourceRunId);
      if (declined === undefined || current === undefined)
        return yield* new RestartHandoffExecutionError({ threadId: input.threadId, sourceRunId });
      const eventSink = yield* EventSink.EventSinkV2;
      const event: OrchestrationV2DomainEvent = {
        id: yield* (yield* IdAllocator.IdAllocatorV2).allocate.event({ threadId: input.threadId }),
        type: "run.updated",
        threadId: input.threadId,
        runId: current.id,
        providerInstanceId: current.providerInstanceId,
        occurredAt: yield* DateTime.now,
        payload: { ...current, restartDeclined: declined },
      };
      const recorded =
        current.activeAttemptId === null
          ? yield* eventSink.write({ events: [event] }).pipe(Effect.as(true))
          : (yield* eventSink.writeIfRunCurrent({
              threadId: input.threadId,
              runId: current.id,
              activeAttemptId: current.activeAttemptId,
              expectedStatus: current.status,
              events: [event],
            })).committed;
      if (!recorded)
        return yield* new RestartHandoffExecutionError({ threadId: input.threadId, sourceRunId });
    }
  },
);
