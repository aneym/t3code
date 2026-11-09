import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as FairMutex from "./FairMutex.ts";

export interface KeyedLock<Key> {
  readonly withLock: <A, E, R>(key: Key, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly withLockWithin: <A, E, R>(
    key: Key,
    within: Duration.Input,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  readonly activeKeys: Effect.Effect<ReadonlyArray<Key>>;
}

interface LockEntry {
  readonly mutex: FairMutex.FairMutex;
  readonly users: number;
}

/**
 * Not reentrant: taking a key while already holding it deadlocks.
 */
export const make = Effect.fn("KeyedLock.make")(function* <Key>(): Effect.fn.Return<
  KeyedLock<Key>
> {
  const locks = yield* Ref.make<ReadonlyMap<Key, LockEntry>>(new Map());

  const acquire = (key: Key) =>
    Ref.modify(locks, (current) => {
      const existing = current.get(key);
      const mutex = existing?.mutex ?? FairMutex.makeUnsafe();
      const next = new Map(current);
      next.set(key, { mutex, users: (existing?.users ?? 0) + 1 });
      return [mutex, next] as const;
    });

  const release = (key: Key) =>
    Ref.update(locks, (current) => {
      const existing = current.get(key);
      if (existing === undefined) return current;
      const next = new Map(current);
      if (existing.users === 1) {
        next.delete(key);
      } else {
        next.set(key, { ...existing, users: existing.users - 1 });
      }
      return next;
    });

  return {
    withLock: (key, effect) =>
      Effect.acquireUseRelease(
        acquire(key),
        (mutex) => mutex.withLock(effect),
        () => release(key),
      ),
    withLockWithin: (key, within, effect) =>
      Effect.acquireUseRelease(
        acquire(key),
        (mutex) => mutex.withLockWithin(within, effect),
        () => release(key),
      ),
    activeKeys: Effect.map(Ref.get(locks), (current) => Array.from(current.keys())),
  } satisfies KeyedLock<Key>;
});
