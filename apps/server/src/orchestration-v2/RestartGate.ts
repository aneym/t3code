import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";

export const makeRestartGate = Effect.fn("RestartGate.make")(function* (
  notifyAvailable: () => Effect.Effect<void>,
) {
  const claimGate = yield* Semaphore.make(1);
  const reopened = yield* Queue.sliding<void>(1);
  let restartEpoch: string | undefined;
  let drain: { readonly epoch: string } | undefined;
  const withDispatch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    claimGate.withPermits(1)(effect);
  const notifyReopened = Effect.gen(function* () {
    yield* notifyAvailable();
    if (restartEpoch === undefined && drain === undefined) yield* Queue.offer(reopened, undefined);
  });
  return {
    withDispatch,
    awaitRestartReopen: Queue.take(reopened),
    restartPrepared: Effect.sync(() => restartEpoch),
    restartDraining: Effect.sync(() => drain?.epoch),
    drainForRestart: (epoch: string) => {
      const owner = { epoch };
      return Effect.acquireRelease(
        withDispatch(
          Effect.sync(() => {
            drain = owner;
          }),
        ),
        () =>
          withDispatch(
            Effect.suspend(() => {
              if (drain !== owner) return Effect.void;
              drain = undefined;
              return notifyReopened;
            }),
          ),
      );
    },
    prepareRestart: (epoch: string) =>
      withDispatch(
        Effect.sync(() => {
          restartEpoch = epoch;
          drain = undefined;
        }),
      ),
    abortRestart: (epoch: string) =>
      withDispatch(
        Effect.suspend(() => {
          if (restartEpoch !== epoch) return Effect.void;
          restartEpoch = undefined;
          return notifyReopened;
        }),
      ),
  };
});
