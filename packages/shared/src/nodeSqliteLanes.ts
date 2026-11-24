import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { makeSlotQueue } from "./nodeSqliteSlotQueue.ts";

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
}

const serves = (slot: ReaderSlot<unknown>, lane: ReadLane) =>
  slot.lane === lane || (slot.lane === "pool" && lane === "interactive");

export const makeReaderSlots = <A>(readers: ReadonlyArray<A>) => {
  const pool = readers.length - RESERVED_READERS;
  return makeSlotQueue<ReaderSlot<A>, ReadLane>(
    [
      { lane: "interactive", reader: readers[pool]! },
      ...readers.slice(0, pool).map((reader) => ({ lane: "pool" as const, reader })),
      { lane: "priority", reader: readers[pool + 1]! },
    ],
    serves,
  );
};
