import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

interface PendingWake {
  readonly count: number;
  readonly dispatched: Deferred.Deferred<void>;
}

export class ProviderWakeDispatches extends Context.Reference<{
  readonly track: (threadId: ThreadId) => Effect.Effect<void>;
  readonly settle: (threadId: ThreadId) => Effect.Effect<void>;
  readonly awaitDispatch: (threadId: ThreadId) => Effect.Effect<void>;
}>("@t3tools/provider-core/server/ProviderWakeDispatches", {
  defaultValue: () => ({
    track: () => Effect.void,
    settle: () => Effect.void,
    awaitDispatch: () => Effect.void,
  }),
}) {}

export const make = Effect.gen(function* () {
  const pending = yield* Ref.make<ReadonlyMap<ThreadId, PendingWake>>(new Map());
  return {
    track: Effect.fn("ProviderWakeDispatches.track")(function* (threadId: ThreadId) {
      yield* Ref.update(pending, (current) => {
        const existing = current.get(threadId);
        return new Map(current).set(threadId, {
          count: (existing?.count ?? 0) + 1,
          dispatched: existing?.dispatched ?? Deferred.makeUnsafe<void>(),
        });
      });
    }),
    settle: Effect.fn("ProviderWakeDispatches.settle")(function* (threadId: ThreadId) {
      const done = yield* Ref.modify(pending, (current) => {
        const existing = current.get(threadId);
        if (existing === undefined) return [undefined, current] as const;
        const next = new Map(current);
        if (existing.count > 1) {
          next.set(threadId, { ...existing, count: existing.count - 1 });
          return [undefined, next] as const;
        }
        next.delete(threadId);
        return [existing.dispatched, next] as const;
      });
      if (done !== undefined) yield* Deferred.succeed(done, undefined);
    }),
    awaitDispatch: Effect.fn("ProviderWakeDispatches.awaitDispatch")(function* (
      threadId: ThreadId,
    ) {
      const wake = (yield* Ref.get(pending)).get(threadId);
      if (wake !== undefined) yield* Deferred.await(wake.dispatched);
    }),
  };
});
