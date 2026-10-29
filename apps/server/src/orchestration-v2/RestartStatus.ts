import {
  CommandId,
  type OrchestrationV2Run,
  ServerPrepareRestartError,
  type ServerRestartStatus,
} from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import { cancelledBeforeStart } from "./RestartBackgroundNote.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const endedOnItsOwn = (status: OrchestrationV2Run["status"]) =>
  status === "failed" || status === "interrupted" || status === "rolled_back";

export const restartStatus = Effect.fn("RestartStatus.read")(
  function* (epoch: string) {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const effects = yield* outbox.listByCommandId(
      CommandId.make(`command:restart-handoff:${epoch}`),
    );
    const threads: ServerRestartStatus["threads"][number][] = [];
    for (const effect of effects) {
      if (effect.request.type !== "provider-runtime.restart-handoff") continue;
      const projection = yield* projections.getThreadProjection(effect.threadId);
      const handoff = effect.request.handoff;
      const sources: ServerRestartStatus["threads"][number]["sources"][number][] = (
        handoff.sourceRunIds ?? handoff.runIds
      ).map((sourceRunId) => {
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
                : projection.turnItems.some(
                      (item) => item.type === "run_interrupt_request" && item.runId === sourceRunId,
                    )
                  ? "explicit_stop"
                  : undefined;
        if (intent !== undefined)
          return { sourceRunId, state: "stopped", intentPreserved: true, reason: intent };
        if (requestIds.length > 0)
          return { sourceRunId, state: "paused", requestIds, reason: "human_review_required" };
        if (source?.status === "completed") return { sourceRunId, state: "completed" };
        if (source !== undefined && endedOnItsOwn(source.status))
          return { sourceRunId, state: "completed", reason: source.status };
        if (
          source?.status === "cancelled" &&
          projection.runs.some(
            (run) =>
              run.id !== source.id &&
              run.status !== "queued" &&
              !cancelledBeforeStart(run) &&
              runRanAfter(run, source),
          )
        )
          return { sourceRunId, state: "completed", reason: "superseded" };
        return { sourceRunId, state: "pending" };
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
