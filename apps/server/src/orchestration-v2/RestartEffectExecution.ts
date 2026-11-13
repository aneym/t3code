import * as Effect from "effect/Effect";
import type { OrchestrationEffectV2 } from "./EffectOutboxModel.ts";
import { recordRestartDeclined } from "./RestartDecline.ts";
import { executeRestartHandoff } from "./RestartHandoffExecution.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export const executeRestartEffect = Effect.fn("RestartEffectExecution.execute")(function* (
  effect: OrchestrationEffectV2,
  willRetry: boolean,
) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const request = effect.request;
  if (
    request.type !== "provider-runtime.continue" &&
    request.type !== "provider-runtime.restart-handoff" &&
    request.type !== "provider-runtime.restart-reapproval"
  )
    return;
  const runIds =
    request.type === "provider-runtime.continue"
      ? [request.sourceRunId]
      : request.type === "provider-runtime.restart-handoff"
        ? request.handoff.runIds
        : request.sourceRunIds;
  const execution = Effect.gen(function* () {
    if (request.type === "provider-runtime.continue") {
      const declined = yield* continueRestartedRun({
        threadId: effect.threadId,
        sourceRunId: request.sourceRunId,
        attempt: effect.attemptCount,
      });
      const { runs, runtimeRequests } = yield* threads.getThreadRecords(effect.threadId, [
        "runs",
        "runtimeRequests",
      ]);
      const source = runs.find((run) => run.id === request.sourceRunId);
      if (
        source !== undefined &&
        !runs.some((run) => run.restartContinuationOfRunId === source.id) &&
        !runtimeRequests.some(
          (request) =>
            request.status === "pending" && request.restartContinuationRunIds?.includes(source.id),
        )
      )
        yield* recordRestartDeclined(effect.threadId, source, declined);
      yield* threads.recoverDelegatedTask(effect.threadId, { sourceRunId: request.sourceRunId });
      return;
    }
    yield* executeRestartHandoff({
      threadId: effect.threadId,
      epoch: request.epoch,
      handoff: request.type === "provider-runtime.restart-handoff" ? request.handoff : { runIds },
      ...(request.type === "provider-runtime.restart-reapproval"
        ? { humanReply: request.text }
        : {}),
      willRetry,
      attempt: effect.attemptCount,
    });
  });
  yield* execution.pipe(
    Effect.tapError(() =>
      willRetry
        ? Effect.void
        : Effect.gen(function* () {
            yield* Effect.gen(function* () {
              const { runs } = yield* threads.getThreadRecords(effect.threadId, ["runs"]);
              for (const source of runs.filter((run) => runIds.includes(run.id))) {
                if (
                  source.status === "cancelled" &&
                  !runs.some((run) => run.restartContinuationOfRunId === source.id)
                )
                  yield* recordRestartDeclined(
                    effect.threadId,
                    source,
                    source.restartDeclined ?? "dispatch_failed",
                  );
              }
            }).pipe(Effect.ignoreCause);
            yield* Effect.forEach(
              runIds,
              (runId) => threads.recoverDelegatedTask(effect.threadId, { sourceRunId: runId }),
              { discard: true },
            );
          }),
    ),
  );
});

export const settleRestartEffect = Effect.fn("RestartEffectExecution.settle")(function* (
  effect: OrchestrationEffectV2,
) {
  if (
    effect.request.type !== "provider-runtime.restart-handoff" &&
    effect.request.type !== "provider-runtime.restart-reapproval" &&
    effect.request.type !== "provider-runtime.continue"
  )
    return;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const request = effect.request;
  const runIds =
    request.type === "provider-runtime.continue"
      ? [request.sourceRunId]
      : request.type === "provider-runtime.restart-handoff"
        ? request.handoff.runIds
        : request.sourceRunIds;
  const { runs } = yield* threads.getThreadRecords(effect.threadId, ["runs"]);
  for (const run of runs.filter((run) => runIds.includes(run.id))) {
    if (run.restartHandoffPending)
      yield* recordRestartDeclined(effect.threadId, run, run.restartDeclined);
  }
  yield* threads.recoverDelegatedTask(effect.threadId);
});
