import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as References from "effect/References";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

interface RegularReaderSlot {
  readonly acquire: Effect.Effect<Connection | undefined>;
  busy: boolean;
}

interface PoolTarget {
  readonly name: "writer" | "reader";
  readonly lock: Semaphore.Semaphore;
  readonly connection: Connection;
}

interface PendingTransactionAcquire {
  acquired?: { readonly connection: "writer" | "reader"; readonly lockWaitMs: number };
  ownerAtWaitStart: unknown;
  restore: typeof Effect.interruptible | undefined;
}

export const makeReaderRouting = Effect.fnUntraced(function* (options: {
  readonly enabled: boolean;
  readonly poolSize: number;
  readonly makeReader: (pool: {
    unavailable: boolean;
  }) => Effect.Effect<Effect.Effect<Connection | undefined>, never, Scope.Scope>;
  readonly writer: Effect.Effect<PoolTarget, SqlError>;
  readonly isReadOnly: (fiber: Fiber.Fiber<unknown, unknown>) => boolean;
  readonly isPriority: (fiber: Fiber.Fiber<unknown, unknown>) => boolean;
  readonly getPendingAcquire: (
    fiber: Fiber.Fiber<unknown, unknown>,
  ) => PendingTransactionAcquire | undefined;
  readonly annotateReaderAcquired: (
    fiber: Fiber.Fiber<unknown, unknown>,
    lockWaitMs: number,
  ) => void;
  readonly borrowTarget: <A, E, R>(
    target: PoolTarget,
    use: (connection: Connection) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly acquireTargetForTransaction: (
    target: PoolTarget,
    restore: typeof Effect.interruptible,
  ) => Effect.Effect<Connection, SqlError>;
}) {
  const pool = { unavailable: false };
  const regularSemaphore = yield* Semaphore.make(options.poolSize);
  const regularSlots: ReadonlyArray<RegularReaderSlot> = options.enabled
    ? yield* Effect.forEach(Array.from({ length: options.poolSize }), () =>
        Effect.map(options.makeReader(pool), (acquire) => ({
          acquire,
          busy: false,
        })),
      )
    : [];
  const reserved = options.enabled
    ? {
        acquire: yield* options.makeReader(pool),
        lock: yield* Semaphore.make(1),
      }
    : undefined;

  const isRegularRead = (fiber: Fiber.Fiber<unknown, unknown>) =>
    regularSlots.length > 0 &&
    !pool.unavailable &&
    options.isReadOnly(fiber) &&
    !options.isPriority(fiber);

  const routeNonRegular = Effect.withFiber((fiber): Effect.Effect<PoolTarget, SqlError> => {
    if (
      reserved === undefined ||
      pool.unavailable ||
      !options.isReadOnly(fiber) ||
      !options.isPriority(fiber)
    ) {
      return options.writer;
    }
    return Effect.flatMap(reserved.acquire, (connection) =>
      connection === undefined
        ? options.writer
        : Effect.succeed<PoolTarget>({
            name: "reader",
            lock: reserved.lock,
            connection,
          }),
    );
  });

  const acquireRegular = (
    restoreWait: typeof Effect.interruptible,
    registerCleanup: (cleanup: Effect.Effect<void>) => Effect.Effect<void>,
  ): Effect.Effect<
    { readonly connection: Connection; readonly lockWaitMs: number } | undefined,
    SqlError
  > =>
    Effect.withFiber((fiber) => {
      const clock = fiber.getRef(Clock.Clock);
      const start = clock.monotonicTimeNanosUnsafe();
      let released = false;
      let slot: RegularReaderSlot | undefined;
      const release = Effect.suspend(() => {
        if (released) return Effect.void;
        released = true;
        if (slot !== undefined) slot.busy = false;
        return regularSemaphore.release(1);
      });
      return Effect.provideService(
        Effect.flatMap(restoreWait(regularSemaphore.take(1)), () => {
          if (pool.unavailable) return Effect.as(release, undefined);
          slot = regularSlots.find((candidate) => !candidate.busy);
          if (slot === undefined) return Effect.as(release, undefined);
          slot.busy = true;
          const lockedSlot = slot;
          const lockWaitMs = Number((clock.monotonicTimeNanosUnsafe() - start) / 1000n) / 1000;
          return Effect.flatMap(registerCleanup(release), () =>
            Effect.flatMap(lockedSlot.acquire, (connection) =>
              connection === undefined
                ? Effect.as(release, undefined)
                : Effect.succeed({ connection, lockWaitMs }),
            ),
          );
        }),
        Scheduler.PreventSchedulerYield,
        true,
      );
    });

  const borrower = <A, E, R>(
    use: (connection: Connection) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | SqlError, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.withFiber((fiber) => {
        if (!isRegularRead(fiber)) {
          return Effect.flatMap(routeNonRegular, (target) =>
            restore(options.borrowTarget(target, use)),
          );
        }
        let release: Effect.Effect<void> = Effect.void;
        return Effect.flatMap(
          acquireRegular(restore, (next) =>
            Effect.sync(() => {
              release = next;
            }),
          ),
          (leased) => {
            if (leased === undefined) {
              return Effect.flatMap(options.writer, (target) =>
                restore(options.borrowTarget(target, use)),
              );
            }
            if (
              fiber.getRef(References.TracerEnabled) &&
              fiber.getRef(Statement.SpanPropagationEnabled)
            ) {
              options.annotateReaderAcquired(fiber, leased.lockWaitMs);
            }
            return restore(use(leased.connection));
          },
        ).pipe(Effect.ensuring(Effect.suspend(() => release)));
      }),
    );

  const transactionAcquirer = Effect.uninterruptibleMask((restore) =>
    Effect.withFiber((fiber) => {
      if (!isRegularRead(fiber)) {
        return Effect.flatMap(routeNonRegular, (target) =>
          options.acquireTargetForTransaction(target, restore),
        );
      }
      const scope = Context.getUnsafe(fiber.context, Scope.Scope);
      const pending = options.getPendingAcquire(fiber);
      return Effect.flatMap(
        acquireRegular(pending?.restore ?? restore, (cleanup) =>
          Scope.addFinalizer(scope, cleanup),
        ),
        (leased) => {
          if (leased === undefined) {
            return Effect.flatMap(options.writer, (target) =>
              options.acquireTargetForTransaction(target, restore),
            );
          }
          if (pending !== undefined) {
            pending.acquired = { connection: "reader", lockWaitMs: leased.lockWaitMs };
            pending.ownerAtWaitStart = undefined;
          }
          return Effect.succeed(leased.connection);
        },
      );
    }),
  );

  return { borrower, transactionAcquirer };
});
