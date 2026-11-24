import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type ReadLane = "pool" | "priority" | "interactive";

export const ReadLaneRef = Context.Reference<ReadLane>("@t3tools/shared/nodeSqliteLanes/ReadLane", {
  defaultValue: () => "pool",
});

export const RESERVED_READERS = 2;

export const prioritized = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, ReadLaneRef, "priority");

export const interactive = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, ReadLaneRef, "interactive");

export interface ReaderSlot<A> {
  readonly lane: ReadLane;
  readonly reader: A;
  busy: boolean;
}

interface Waiter<A> {
  readonly lane: ReadLane;
  slot: ReaderSlot<A> | undefined;
  wake: (() => void) | undefined;
}

const serves = (slot: ReadLane, lane: ReadLane) =>
  slot === lane || (slot === "pool" && lane === "interactive");

export const makeReaderSlots = <A>(readers: ReadonlyArray<A>) => {
  const pool = readers.length - RESERVED_READERS;
  const slots: ReadonlyArray<ReaderSlot<A>> = [
    { lane: "interactive", reader: readers[pool]!, busy: false },
    ...readers.slice(0, pool).map((reader) => ({ lane: "pool" as const, reader, busy: false })),
    { lane: "priority", reader: readers[pool + 1]!, busy: false },
  ];
  const waiters: Array<Waiter<A>> = [];

  const release = (slot: ReaderSlot<A>) =>
    Effect.sync(() => {
      const index = waiters.findIndex((waiter) => serves(slot.lane, waiter.lane));
      if (index === -1) {
        slot.busy = false;
        return;
      }
      const waiter = waiters.splice(index, 1)[0]!;
      waiter.slot = slot;
      waiter.wake?.();
    });

  const take = (
    lane: ReadLane,
    restoreWait: typeof Effect.interruptible,
  ): Effect.Effect<ReaderSlot<A>> =>
    Effect.suspend(() => {
      const free = slots.find((slot) => !slot.busy && serves(slot.lane, lane));
      if (free !== undefined) {
        free.busy = true;
        return Effect.succeed(free);
      }
      const waiter: Waiter<A> = { lane, slot: undefined, wake: undefined };
      waiters.push(waiter);
      return restoreWait(
        Effect.callback<ReaderSlot<A>>((resume) => {
          if (waiter.slot !== undefined) return resume(Effect.succeed(waiter.slot));
          waiter.wake = () => resume(Effect.succeed(waiter.slot!));
        }),
      ).pipe(
        Effect.onInterrupt(() => {
          if (waiter.slot !== undefined) return release(waiter.slot);
          return Effect.sync(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
          });
        }),
      );
    });

  return { take, release };
};
