import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scheduler from "effect/Scheduler";

export interface FairMutex {
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly withLockWithin: <A, E, R>(
    within: Duration.Input,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
}

interface Waiter {
  granted: boolean;
  readonly grant: () => void;
}

export const makeUnsafe = (): FairMutex => {
  let held = false;
  const waiters = new Set<Waiter>();

  const release = (dispatcher: Scheduler.SchedulerDispatcher) => {
    for (const next of waiters) {
      waiters.delete(next);
      next.granted = true;
      dispatcher.scheduleTask(next.grant, 0);
      return;
    }
    held = false;
  };
  const releasing = Effect.withFiber((fiber) =>
    Effect.sync(() => release(fiber.currentDispatcher)),
  );

  const acquire = (timeoutMillis: number | undefined) =>
    Effect.callback<boolean>((resume) => {
      if (!held) {
        held = true;
        resume(Effect.succeed(true));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        granted: false,
        grant: () => {
          clearTimeout(timer);
          resume(Effect.succeed(true));
        },
      };
      waiters.add(waiter);
      if (timeoutMillis !== undefined) {
        // @effect-diagnostics-next-line globalTimersInEffect:off -- Expiry must settle in the same tick as a grant.
        timer = setTimeout(() => {
          if (waiters.delete(waiter)) resume(Effect.succeed(false));
        }, timeoutMillis);
      }
      return Effect.suspend(() => {
        clearTimeout(timer);
        if (waiter.granted) return releasing;
        waiters.delete(waiter);
        return Effect.void;
      });
    });

  const holding = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.ensuring(effect, releasing);

  return {
    withLock: (effect) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.andThen(restore(acquire(undefined)), holding(restore(effect))),
      ),
    withLockWithin: (within, effect) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.flatMap(
          restore(acquire(Duration.toMillis(Duration.fromInputUnsafe(within)))),
          (acquired) => (acquired ? Effect.asSome(holding(restore(effect))) : Effect.succeedNone),
        ),
      ),
  };
};
