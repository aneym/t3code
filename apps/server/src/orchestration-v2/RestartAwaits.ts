import type { OrchestrationV2Run, RunId } from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as EffectOutbox from "./EffectOutbox.ts";

export const restartHandoffRunIds = (
  handoffs: ReadonlyArray<import("./EffectOutboxModel.ts").OrchestrationEffectV2>,
) =>
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
  ) {
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
  runs: ReadonlyArray<OrchestrationV2Run>,
  resultRun: OrchestrationV2Run,
  settledContinuationOf?: RunId,
) {
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
    handoffs?: ReadonlyArray<import("./EffectOutboxModel.ts").OrchestrationEffectV2>,
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
