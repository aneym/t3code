import type { OrchestrationV2Run, RunId } from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as EffectOutbox from "./EffectOutbox.ts";
import type { OrchestrationEffectV2 } from "./EffectOutboxModel.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

export const restartHandoffRunIds = (handoffs: ReadonlyArray<OrchestrationEffectV2>) =>
  new Set(
    handoffs.flatMap((effect) =>
      effect.request.type === "provider-runtime.restart-handoff"
        ? effect.request.handoff.runIds
        : [],
    ),
  );

export const awaitsRestartContinuation = Effect.fn("RestartAwaits.awaitsRestartContinuation")(
  function* (
    outbox: EffectOutbox.EffectOutboxV2["Service"],
    run: OrchestrationV2Run,
    handoffRunIds?: ReadonlySet<RunId>,
    continuationRunIds?: ReadonlySet<RunId>,
  ) {
    if (continuationRunIds !== undefined)
      return continuationRunIds.has(run.id) || handoffRunIds?.has(run.id) === true;
    const continuation = yield* outbox.get(`effect:restart-continuation:${run.id}`);
    if (
      Option.exists(
        continuation,
        (effect) => effect.status === "pending" || effect.status === "running",
      )
    )
      return true;
    return (handoffRunIds ?? restartHandoffRunIds(yield* outbox.restartHandoffs)).has(run.id);
  },
);

export const childAwaitsRestartContinuation = Effect.fn("RestartAwaits.childPending")(function* (
  outbox: EffectOutbox.EffectOutboxV2["Service"],
  projections: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  runs: ReadonlyArray<OrchestrationV2Run>,
  resultRun: OrchestrationV2Run,
  settledContinuationOf?: RunId,
) {
  const { runtimeRequests } = yield* projections.getThreadRecords(resultRun.threadId, [
    "runtimeRequests",
  ]);
  if (
    runtimeRequests.some(
      (request) =>
        request.status === "pending" &&
        request.restartContinuationRunIds?.some((id) => runs.some((run) => run.id === id)),
    )
  )
    return true;
  const handoffRunIds = restartHandoffRunIds(yield* outbox.restartHandoffs);
  return Option.isSome(
    yield* Effect.findFirst(
      runs.filter(
        (run) =>
          run.id !== settledContinuationOf &&
          (run.id === resultRun.id || runRanAfter(run, resultRun)),
      ),
      (run) => awaitsRestartContinuation(outbox, run, handoffRunIds),
    ),
  );
});

export const awaitRestartContinuation = Effect.fn("RestartAwaits.awaitRestartContinuation")(
  function* (
    outbox: EffectOutbox.EffectOutboxV2["Service"],
    run: OrchestrationV2Run,
    handoffs?: ReadonlyArray<OrchestrationEffectV2>,
  ) {
    yield* outbox.awaitSettled(`effect:restart-continuation:${run.id}`);
    for (const effect of handoffs ?? (yield* outbox.restartHandoffs)) {
      if (
        effect.request.type === "provider-runtime.restart-handoff" &&
        effect.request.handoff.runIds.includes(run.id)
      )
        yield* outbox.awaitSettled(effect.id);
    }
  },
);

export const threadAwaitsRestartContinuation = Effect.fn("RestartAwaits.threadPending")(function* (
  outbox: EffectOutbox.EffectOutboxV2["Service"],
  runs: ReadonlyArray<OrchestrationV2Run>,
) {
  const effects = yield* outbox.unsettledEffects([
    "provider-runtime.restart-handoff",
    "provider-runtime.continue",
  ]);
  const handoffs = restartHandoffRunIds(effects);
  const continuations = new Set(
    effects.flatMap((effect) =>
      effect.request.type === "provider-runtime.continue" ? [effect.request.sourceRunId] : [],
    ),
  );
  return runs.some((run) => continuations.has(run.id) || handoffs.has(run.id));
});
