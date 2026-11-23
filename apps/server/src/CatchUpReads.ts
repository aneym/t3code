import type * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const snapshots = Semaphore.makeUnsafe(2);
const assets = Semaphore.makeUnsafe(2);

export const catchUpRead = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  snapshots.withPermit(effect);

export const assetLookup = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  assets.withPermit(effect);
