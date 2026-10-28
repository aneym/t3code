import { CommandId, ServerPrepareRestartError, type ServerRestartStatus } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export const restartStatus = Effect.fn("RestartStatus.read")(
  function* (epoch: string) {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const effects = yield* outbox.listByCommandId(
      CommandId.make(`command:restart-handoff:${epoch}`),
    );
    const now = yield* DateTime.now;
    const threads: ServerRestartStatus["threads"][number][] = [];
    for (const effect of effects) {
      if (effect.request.type !== "provider-runtime.restart-handoff") continue;
      const projection = yield* projections.getThreadProjection(effect.threadId);
      const handoff = effect.request.handoff;
      const sources: ServerRestartStatus["threads"][number]["sources"][number][] =
        handoff.runIds.map((sourceRunId) => {
          const continuation = projection.runs.find(
            (run) => run.restartContinuationOfRunId === sourceRunId,
          );
          if (continuation !== undefined)
            return { sourceRunId, state: "continued", continuationRunId: continuation.id };
          const source = projection.runs.find((run) => run.id === sourceRunId);
          const requestIds = projection.runtimeRequests
            .filter(
              (request) =>
                request.status === "pending" &&
                request.restartContinuationRunIds?.includes(sourceRunId),
            )
            .map((request) => request.id);
          const intent =
            projection.thread.deletedAt !== null
              ? "deleted"
              : projection.thread.archivedAt !== null
                ? "archived"
                : projection.thread.settledOverride === "settled"
                  ? "settled"
                  : projection.thread.snoozedUntil != null &&
                      DateTime.isGreaterThan(projection.thread.snoozedUntil, now)
                    ? "snoozed"
                    : projection.turnItems.some(
                          (item) =>
                            item.type === "run_interrupt_request" && item.runId === sourceRunId,
                        )
                      ? "explicit_stop"
                      : undefined;
          if (intent !== undefined)
            return { sourceRunId, state: "stopped", intentPreserved: true, reason: intent };
          const paused = requestIds.length > 0;
          return {
            sourceRunId,
            state: paused ? "paused" : source?.status === "completed" ? "completed" : "pending",
            ...(paused ? { requestIds, reason: "human_review_required" } : {}),
          };
        });
      const queueIds = new Set([
        ...handoff.queuedRunIds,
        ...projection.runs.filter((run) => run.status === "queued").map((run) => run.id),
      ]);
      threads.push({
        threadId: effect.threadId,
        sources,
        queues: projection.runs
          .filter((run) => queueIds.has(run.id))
          .map((run) => ({
            runId: run.id,
            messageId: run.userMessageId,
            state: run.status,
            deliveryRunId:
              projection.messages.find((message) => message.id === run.userMessageId)?.runId ??
              null,
          })),
      });
    }
    return { epoch, threads };
  },
  Effect.mapError((cause) => new ServerPrepareRestartError({ cause })),
);
