import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

export interface RestartGate {
  readonly withDispatch: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly awaitRestartReopen: Effect.Effect<void>;
  readonly restartPrepared: Effect.Effect<string | undefined>;
  readonly restartDraining: Effect.Effect<string | undefined>;
  readonly draining: Effect.Effect<boolean>;
  readonly serverDrainSince: Effect.Effect<number | undefined>;
  readonly holdServerDrain: (held: boolean, now: number) => Effect.Effect<void>;
  readonly drainForRestart: (epoch: string) => Effect.Effect<void, never, Scope.Scope>;
  readonly prepareRestart: (epoch: string) => Effect.Effect<void>;
  readonly abortRestart: (epoch: string) => Effect.Effect<void>;
}

export const makeRestartGate = Effect.fn("RestartGate.make")(function* (
  notifyAvailable: () => Effect.Effect<void>,
) {
  const claimGate = yield* Semaphore.make(1);
  const reopened = yield* Queue.sliding<void>(1);
  let restartEpoch: string | undefined;
  let drain: { readonly epoch: string } | undefined;
  let serverDrainSince: number | undefined;
  const withDispatch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    claimGate.withPermits(1)(effect);
  const notifyReopened = Effect.gen(function* () {
    yield* notifyAvailable();
    if (restartEpoch === undefined && drain === undefined && serverDrainSince === undefined)
      yield* Queue.offer(reopened, undefined);
  });
  return {
    withDispatch,
    awaitRestartReopen: Queue.take(reopened),
    restartPrepared: Effect.sync(() => restartEpoch),
    restartDraining: Effect.sync(() => drain?.epoch),
    draining: Effect.sync(() => drain !== undefined || serverDrainSince !== undefined),
    serverDrainSince: Effect.sync(() => serverDrainSince),
    holdServerDrain: (held: boolean, now: number) =>
      withDispatch(
        Effect.suspend(() => {
          if (held) serverDrainSince ??= now;
          if (held || serverDrainSince === undefined) return Effect.void;
          serverDrainSince = undefined;
          return notifyReopened;
        }),
      ),
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
  } satisfies RestartGate;
});
