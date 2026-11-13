import * as FairMutex from "@t3tools/shared/FairMutex";
import * as FairRwLock from "@t3tools/shared/FairRwLock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type GateLabel, makeGateRecorder } from "./DispatchGateRecord.ts";

export interface DispatchGateShape {
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
}

export const makeDispatchGate = Effect.gen(function* () {
  const admission = FairRwLock.makeUnsafe();
  const commitGate = FairMutex.makeUnsafe();
  const recorder = yield* makeGateRecorder;
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
  return {
    admit,
    admitWithin,
    withCommit,
    withClaim: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      admit({ type: "outbox.claim" }, "shared", withCommit(effect)),
  };
});
