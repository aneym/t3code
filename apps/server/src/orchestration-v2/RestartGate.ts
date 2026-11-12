import * as FairMutex from "@t3tools/shared/FairMutex";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";

import { type GateLabel, makeGateRecorder } from "./DispatchGateRecord.ts";

export interface RestartGateShape {
  readonly withDispatch: <A, E, R>(
    label: GateLabel,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly awaitRestartReopen: Effect.Effect<void>;
  readonly abortRestart: (epoch: string) => Effect.Effect<void>;
  readonly restartPrepared: Effect.Effect<string | undefined>;
  readonly prepareRestart: (epoch: string) => Effect.Effect<void>;
  readonly restartDraining: Effect.Effect<string | undefined>;
  readonly drainForRestart: (epoch: string) => Effect.Effect<void, never, Scope.Scope>;
}

export const makeRestartGate = Effect.fn("RestartGate.make")(function* (
  notifyAvailable: () => Effect.Effect<void>,
) {
  const claimGate = FairMutex.makeUnsafe();
  const recorder = yield* makeGateRecorder;
  const reopened = yield* Queue.sliding<void>(1);
  let restartEpoch: string | undefined;
  let drain: { readonly epoch: string } | undefined;
  const withDispatch = <A, E, R>(label: GateLabel, effect: Effect.Effect<A, E, R>) =>
    recorder.record(label, (held) => claimGate.withLock(NodeSqliteClient.prioritized(held)))(
      effect,
    );
  const notifyReopened = Effect.gen(function* () {
    yield* notifyAvailable();
    if (restartEpoch === undefined && drain === undefined) yield* Queue.offer(reopened, undefined);
  });
  return {
    withDispatch,
    withClaim: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      withDispatch({ type: "outbox.claim" }, effect),
    awaitRestartReopen: Queue.take(reopened),
    restartPrepared: Effect.sync(() => restartEpoch),
    restartDraining: Effect.sync(() => drain?.epoch),
    drainForRestart: (epoch: string) => {
      const owner = { epoch };
      return Effect.acquireRelease(
        withDispatch(
          { type: "restart.drain" },
          Effect.sync(() => {
            drain = owner;
          }),
        ),
        () =>
          withDispatch(
            { type: "restart.reopen" },
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
        { type: "restart.prepare" },
        Effect.sync(() => {
          restartEpoch = epoch;
          drain = undefined;
        }),
      ),
    abortRestart: (epoch: string) =>
      withDispatch(
        { type: "restart.abort" },
        Effect.suspend(() => {
          if (restartEpoch !== epoch) return Effect.void;
          restartEpoch = undefined;
          return notifyReopened;
        }),
      ),
  };
});
