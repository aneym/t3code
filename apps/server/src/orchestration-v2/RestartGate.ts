import * as FairMutex from "@t3tools/shared/FairMutex";
import * as FairRwLock from "@t3tools/shared/FairRwLock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";

import { type GateLabel, makeGateRecorder } from "./DispatchGateRecord.ts";

export interface RestartGateShape {
  readonly admit: <A, E, R>(
    label: GateLabel,
    mode: FairRwLock.FairRwLockMode,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly admitWithin: <A, E, R>(
    label: GateLabel,
    mode: FairRwLock.FairRwLockMode,
    withinMs: number,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  readonly withCommit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
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
  const admission = FairRwLock.makeUnsafe();
  const commitGate = FairMutex.makeUnsafe();
  const recorder = yield* makeGateRecorder;
  const reopened = yield* Queue.sliding<void>(1);
  let restartEpoch: string | undefined;
  let drain: { readonly epoch: string } | undefined;
  const admit = <A, E, R>(
    label: GateLabel,
    mode: FairRwLock.FairRwLockMode,
    effect: Effect.Effect<A, E, R>,
  ) =>
    recorder.record(
      label,
      (held: Effect.Effect<A, E, R>) =>
        admission.withLock(mode, NodeSqliteClient.prioritized(held)),
      effect,
    );
  const admitWithin = <A, E, R>(
    label: GateLabel,
    mode: FairRwLock.FairRwLockMode,
    withinMs: number,
    effect: Effect.Effect<A, E, R>,
  ) =>
    recorder.record(
      label,
      (held: Effect.Effect<A, E, R>) =>
        admission.withLockWithin(mode, withinMs, NodeSqliteClient.prioritized(held)),
      effect,
    );
  const withCommit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    recorder.record(
      { type: "commit" },
      (held: Effect.Effect<A, E, R>) => commitGate.withLock(held),
      effect,
    );
  const exclusive = <A, E, R>(type: string, effect: Effect.Effect<A, E, R>) =>
    admit({ type }, "exclusive", effect);
  const notifyReopened = Effect.gen(function* () {
    yield* notifyAvailable();
    if (restartEpoch === undefined && drain === undefined) yield* Queue.offer(reopened, undefined);
  });
  return {
    admit,
    admitWithin,
    withCommit,
    withClaim: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      admit({ type: "outbox.claim" }, "shared", withCommit(effect)),
    awaitRestartReopen: Queue.take(reopened),
    restartPrepared: Effect.sync(() => restartEpoch),
    restartDraining: Effect.sync(() => drain?.epoch),
    drainForRestart: (epoch: string) => {
      const owner = { epoch };
      return Effect.acquireRelease(
        exclusive(
          "restart.drain",
          Effect.sync(() => {
            drain = owner;
          }),
        ),
        () =>
          exclusive(
            "restart.reopen",
            Effect.suspend(() => {
              if (drain !== owner) return Effect.void;
              drain = undefined;
              return notifyReopened;
            }),
          ),
      );
    },
    prepareRestart: (epoch: string) =>
      exclusive(
        "restart.prepare",
        Effect.sync(() => {
          restartEpoch = epoch;
          drain = undefined;
        }),
      ),
    abortRestart: (epoch: string) =>
      exclusive(
        "restart.abort",
        Effect.suspend(() => {
          if (restartEpoch !== epoch) return Effect.void;
          restartEpoch = undefined;
          return notifyReopened;
        }),
      ),
  };
});
