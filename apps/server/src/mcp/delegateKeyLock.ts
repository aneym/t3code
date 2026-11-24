import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

class DelegateKeyHold extends Context.Service<
  DelegateKeyHold,
  { readonly release: Effect.Effect<void> }
>()("t3/mcp/delegateKeyLock/DelegateKeyHold") {}

const keys = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();

export const withDelegateKey = <A, E, R>(
  key: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const entry = keys.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    keys.set(key, entry);
    entry.users++;
    let held = false;
    const release = Effect.suspend(() => {
      if (!held) return Effect.void;
      held = false;
      return Effect.asVoid(entry.semaphore.release(1));
    });
    return Effect.uninterruptibleMask((restore) =>
      restore(entry.semaphore.take(1)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            held = true;
          }),
        ),
        Effect.andThen(restore(Effect.provideService(effect, DelegateKeyHold, { release }))),
        Effect.ensuring(
          release.pipe(
            Effect.andThen(
              Effect.sync(() => {
                entry.users--;
                if (entry.users === 0) keys.delete(key);
              }),
            ),
          ),
        ),
      ),
    );
  });

export const releaseDelegateKey: Effect.Effect<void> = Effect.flatMap(
  Effect.serviceOption(DelegateKeyHold),
  Option.match({ onNone: () => Effect.void, onSome: (hold) => hold.release }),
);
