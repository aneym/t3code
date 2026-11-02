import type { OrchestrationV2Run, RunId } from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as EffectOutbox from "./EffectOutbox.ts";

export const awaitsRestartContinuation = Effect.fn("RestartAwaits.awaitsRestartContinuation")(
  function* (outbox: EffectOutbox.EffectOutboxV2["Service"], run: OrchestrationV2Run) {
    const continuation = yield* outbox.get(`effect:restart-continuation:${run.id}`);
    if (
      Option.exists(
        continuation,
        (effect) => effect.status === "pending" || effect.status === "running",
      )
    )
      return true;
    return (yield* outbox.restartHandoffs).some(
      (effect) =>
        effect.request.type === "provider-runtime.restart-handoff" &&
        effect.request.handoff.runIds.includes(run.id),
    );
  },
);

export const childAwaitsRestartContinuation = (
  outbox: EffectOutbox.EffectOutboxV2["Service"],
  runs: ReadonlyArray<OrchestrationV2Run>,
  resultRun: OrchestrationV2Run,
  settledContinuationOf?: RunId,
) =>
  Effect.forEach(
    runs.filter(
      (run) =>
        run.id !== settledContinuationOf &&
        (run.id === resultRun.id || runRanAfter(run, resultRun)),
    ),
    (run) => awaitsRestartContinuation(outbox, run),
  ).pipe(Effect.map((pending) => pending.includes(true)));

export const awaitRestartContinuation = Effect.fn("RestartAwaits.awaitRestartContinuation")(
  function* (outbox: EffectOutbox.EffectOutboxV2["Service"], run: OrchestrationV2Run) {
    yield* outbox.awaitSettled(`effect:restart-continuation:${run.id}`);
    for (const effect of yield* outbox.restartHandoffs) {
      if (
        effect.request.type === "provider-runtime.restart-handoff" &&
        effect.request.handoff.runIds.includes(run.id)
      )
        yield* outbox.awaitSettled(effect.id);
    }
  },
);
