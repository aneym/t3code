import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scheduler from "effect/Scheduler";

export type FairRwLockMode = "shared" | "exclusive";

export interface FairRwLock {
  readonly withLock: <A, E, R>(
    mode: FairRwLockMode,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly withLockWithin: <A, E, R>(
    mode: FairRwLockMode,
    within: Duration.Input,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
}

interface Waiter {
  readonly mode: FairRwLockMode;
  granted: boolean;
  readonly grant: () => void;
}

export const makeUnsafe = (): FairRwLock => {
  let shared = 0;
  let exclusive = false;
  const waiters: Array<Waiter> = [];

  const admits = (mode: FairRwLockMode) => !exclusive && (mode === "shared" || shared === 0);
  const take = (mode: FairRwLockMode) => {
    if (mode === "shared") shared += 1;
    else exclusive = true;
  };

  const grantWaiting = (dispatcher: Scheduler.SchedulerDispatcher) => {
    while (waiters.length > 0) {
      const next = waiters[0]!;
      if (!admits(next.mode)) return;
      waiters.shift();
      take(next.mode);
      next.granted = true;
      dispatcher.scheduleTask(next.grant, 0);
    }
  };
  const release = (mode: FairRwLockMode) =>
    Effect.withFiber((fiber) =>
      Effect.sync(() => {
        if (mode === "shared") shared -= 1;
        else exclusive = false;
        grantWaiting(fiber.currentDispatcher);
      }),
    );
  const regrant = Effect.withFiber((fiber) =>
    Effect.sync(() => grantWaiting(fiber.currentDispatcher)),
  );

  const acquire = (mode: FairRwLockMode, timeoutMillis: number | undefined) =>
    Effect.callback<boolean>((resume) => {
      if (waiters.length === 0 && admits(mode)) {
        take(mode);
        resume(Effect.succeed(true));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        mode,
        granted: false,
        grant: () => {
          clearTimeout(timer);
          resume(Effect.succeed(true));
        },
      };
      waiters.push(waiter);
      const leave = () => {
        const index = waiters.indexOf(waiter);
        if (index === -1) return false;
        waiters.splice(index, 1);
        return true;
      };
      if (timeoutMillis !== undefined) {
        // @effect-diagnostics-next-line globalTimersInEffect:off -- Expiry must settle in the same tick as a grant.
        timer = setTimeout(() => {
          if (!leave()) return;
          resume(Effect.as(regrant, false));
        }, timeoutMillis);
      }
      return Effect.suspend(() => {
        clearTimeout(timer);
        if (waiter.granted) return release(mode);
        leave();
        return regrant;
      });
    });

  const holding = <A, E, R>(mode: FairRwLockMode, effect: Effect.Effect<A, E, R>) =>
    Effect.ensuring(effect, release(mode));

  return {
    withLock: (mode, effect) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.andThen(restore(acquire(mode, undefined)), holding(mode, restore(effect))),
      ),
    withLockWithin: (mode, within, effect) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.flatMap(
          restore(acquire(mode, Duration.toMillis(Duration.fromInputUnsafe(within)))),
          (acquired) =>
            acquired ? Effect.asSome(holding(mode, restore(effect))) : Effect.succeedNone,
        ),
      ),
  };
};
