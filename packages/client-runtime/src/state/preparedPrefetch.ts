import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { PreparedConnection } from "../connection/model.ts";

type PreparedRef = SubscriptionRef.SubscriptionRef<Option.Option<PreparedConnection>>;

export const awaitPreparedConnection = (prepared: PreparedRef) =>
  SubscriptionRef.changes(prepared).pipe(
    Stream.filter(Option.isSome),
    Stream.map((value) => value.value),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

export const prefetchOnPrepared = <A>(
  prepared: PreparedRef,
  load: (connection: PreparedConnection) => Effect.Effect<A>,
): Effect.Effect<Effect.Effect<Option.Option<A>>, never, Scope.Scope> =>
  awaitPreparedConnection(prepared).pipe(
    Effect.flatMap(load),
    Effect.forkScoped,
    Effect.map((fiber) => {
      let pending = Effect.asSome(Fiber.join(fiber));
      return Effect.suspend(() => {
        const next = pending;
        pending = Effect.succeedNone;
        return next;
      });
    }),
  );
