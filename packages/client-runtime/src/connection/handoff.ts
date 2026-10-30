import { WS_METHODS } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as RpcSession from "../rpc/session.ts";
import type { SupervisorConnectionState } from "./model.ts";

export const makeHandoffWindow = Effect.fn("ConnectionHandoff.make")(function* (
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
) {
  const clientId = `${yield* Random.nextInt}:${yield* Random.nextInt}`;
  const deadline = yield* Ref.make(0);
  const rawState = yield* Ref.make(yield* SubscriptionRef.get(state));
  const ownerScope = yield* Effect.scope;
  let expiry: Fiber.Fiber<void> | undefined;
  const active = Effect.all([Clock.currentTimeMillis, Ref.get(deadline)]).pipe(
    Effect.map(([now, until]) => now < until),
  );
  const setState = Effect.fn("ConnectionHandoff.setState")(function* (
    next: SupervisorConnectionState,
  ) {
    yield* Ref.set(rawState, next);
    const transparent = next.desired && next.phase !== "blocked" && (yield* active);
    yield* SubscriptionRef.set(
      state,
      transparent
        ? { ...next, phase: "connected" as const, stage: null, lastFailure: null, retryAt: null }
        : next,
    );
  });
  const watch = Effect.fn("ConnectionHandoff.watch")(function* (session: RpcSession.RpcSession) {
    const subscribe = session.client[WS_METHODS.subscribeServerLifecycle];
    if (subscribe === undefined) return yield* Effect.never;
    const hint = yield* subscribe({ handoffClientId: clientId }).pipe(
      Stream.filter((event) => event.type === "handoff"),
      Stream.mapEffect(
        Effect.fn("ConnectionHandoff.receive")(function* (event) {
          const window = Math.min(event.payload.reconnectWithinMs, 300_000);
          yield* Ref.set(deadline, (yield* Clock.currentTimeMillis) + window);
          if (expiry !== undefined) yield* Fiber.interrupt(expiry);
          expiry = yield* Effect.forkIn(
            Effect.sleep(window).pipe(
              Effect.andThen(Ref.set(deadline, 0)),
              Effect.andThen(Ref.get(rawState)),
              Effect.flatMap((next) => SubscriptionRef.set(state, next)),
            ),
            ownerScope,
          );
          yield* session.client[WS_METHODS.serverProbe]({
            handoffClientId: clientId,
            handoffSequence: event.sequence,
          }).pipe(Effect.ignore);
          return event;
        }),
      ),
      Stream.runHead,
      Effect.catchCause(() => Effect.never),
    );
    if (hint._tag === "None") return yield* Effect.never;
    return true;
  });
  const pause = Effect.gen(function* () {
    const remaining = (yield* Ref.get(deadline)) - (yield* Clock.currentTimeMillis);
    if (remaining > 0) yield* Effect.sleep(Math.min(300, remaining));
  });
  return { active, setState, watch, pause };
});
