import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const snapshots = Semaphore.makeUnsafe(2);
const assets = Semaphore.makeUnsafe(2);
const PER_SESSION = 2;
const sessions = new Map<string, { readonly permits: Semaphore.Semaphore; users: number }>();

export const catchUp = <A, E, R>(
  sessionId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const entry = sessions.get(sessionId) ?? {
      permits: Semaphore.makeUnsafe(PER_SESSION),
      users: 0,
    };
    sessions.set(sessionId, entry);
    entry.users++;
    return entry.permits.withPermit(snapshots.withPermit(effect)).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          entry.users--;
          if (entry.users === 0) sessions.delete(sessionId);
        }),
      ),
    );
  });

export const shellRead = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  snapshots.withPermit(effect);

export const assetLookup = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  assets.withPermit(effect);
