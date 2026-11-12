import {
  CommandId,
  type OrchestrationV2Run,
  ServerPrepareRestartError,
  type ServerRestartStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { restartNoteOwed } from "./RestartBackgroundNote.ts";
import { restartDispatchRefusal } from "./RestartDispatchPolicy.ts";

const endedOnItsOwn = (status: OrchestrationV2Run["status"]) =>
  status === "failed" || status === "interrupted" || status === "rolled_back";

export const restartStatus = Effect.fn("RestartStatus.read")(
  function* (epoch: string) {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { effects, preparedHandoffs, projectionsByThread } = yield* outbox.withTransaction(
      Effect.gen(function* () {
        const effects = yield* outbox.listByCommandId(
          CommandId.make(`command:restart-handoff:${epoch}`),
        );
        const preparedHandoffs = yield* outbox.restartHandoffs;
        const projectionsByThread = new Map(
          yield* Effect.forEach(new Set(effects.map((effect) => effect.threadId)), (threadId) =>
            projections
              .getThreadProjection(threadId)
              .pipe(Effect.map((projection) => [threadId, projection] as const)),
          ),
        );
        return { effects, preparedHandoffs, projectionsByThread };
      }),
    );
    const threads: ServerRestartStatus["threads"][number][] = [];
    for (const effect of effects) {
      if (effect.request.type !== "provider-runtime.restart-handoff") continue;
      const projection = projectionsByThread.get(effect.threadId);
      if (projection === undefined) continue;
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
        const owed = source !== undefined && restartNoteOwed(source, projection.providerTurns);
        if (source?.status === "completed" && !owed) return { sourceRunId, state: "completed" };
        if (source !== undefined && endedOnItsOwn(source.status))
          return { sourceRunId, state: "completed", reason: source.status };
        if (source !== undefined && source.status !== "cancelled" && !owed)
          return { sourceRunId, state: "pending" };
        const refusal = restartDispatchRefusal(projection, sourceRunId, preparedHandoffs);
        return refusal === undefined
          ? { sourceRunId, state: "pending" }
          : { sourceRunId, state: "completed", reason: refusal };
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
