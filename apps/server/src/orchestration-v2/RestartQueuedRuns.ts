import * as Effect from "effect/Effect";
import type { OrchestratorV2Error } from "./OrchestratorErrors.ts";
import { forkParked } from "../serverActivation.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

export const resumeOnReopen = Effect.fn("RestartQueuedRuns.resumeOnReopen")(function* <
  A extends { readonly resumeQueuedRuns: Effect.Effect<number, OrchestratorV2Error> },
  E,
  R,
>(effect: Effect.Effect<A, E, R>) {
  const service = yield* effect;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  yield* outbox.awaitRestartReopen.pipe(
    Effect.andThen(
      service.resumeQueuedRuns.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to resume queued runs after restart admission reopened", {
            cause,
          }),
        ),
        Effect.forkScoped,
      ),
    ),
    Effect.forever,
    forkParked,
  );
  return service;
});
