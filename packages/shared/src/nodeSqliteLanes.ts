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

export const pickReader = <Slot extends { readonly claims: number }>(
  readers: ReadonlyArray<Slot>,
  lane: ReadLane,
): Slot => {
  const pool = readers.length - RESERVED_READERS;
  if (lane === "priority") return readers[pool + 1]!;
  let slot = readers[lane === "interactive" ? pool : 0]!;
  for (let index = 0; index < pool; index++)
    if (readers[index]!.claims < slot.claims) slot = readers[index]!;
  return slot;
};
