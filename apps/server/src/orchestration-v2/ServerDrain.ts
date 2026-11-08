import {
  ServerDrainError,
  type ServerDrainStatus,
  type ServerDrainWaitResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { activeRuns, awaitNoActiveRuns } from "./RestartDrain.ts";

export class ServerDrain extends Context.Service<
  ServerDrain,
  {
    readonly set: (draining: boolean) => Effect.Effect<ServerDrainStatus, ServerDrainError>;
    readonly status: Effect.Effect<ServerDrainStatus, ServerDrainError>;
    readonly wait: (timeoutMs: number) => Effect.Effect<ServerDrainWaitResult, ServerDrainError>;
  }
>()("t3/orchestration-v2/ServerDrain") {}

const toDrainError = (cause: unknown) => new ServerDrainError({ cause });

const make = Effect.gen(function* () {
  const context = yield* Effect.context<
    EffectOutbox.EffectOutboxV2 | ProjectionStore.ProjectionStoreV2 | EventSink.EventSinkV2
  >();
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const status = Effect.gen(function* () {
    const since = yield* outbox.serverDrainSince;
    const active = yield* activeRuns("cold");
    const waiting = yield* projections.getRecoveryThreadIds("queued-runs");
    return {
      draining: since !== undefined,
      since: since === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(since)),
      activeRunIds: [...active.values()].flat(),
      waitingThreadIds: [...waiting],
    } satisfies ServerDrainStatus;
  }).pipe(Effect.provide(context), Effect.mapError(toDrainError));

  const set = Effect.fn("ServerDrain.set")(function* (draining: boolean) {
    yield* outbox.holdServerDrain(draining, yield* Clock.currentTimeMillis);
    const current = yield* status;
    yield* Effect.logInfo(draining ? "Server drain on" : "Server drain off", {
      since: current.since,
      activeRuns: current.activeRunIds.length,
    });
    return current;
  });

  const wait = Effect.fn("ServerDrain.wait")(function* (timeoutMs: number) {
    const result = yield* awaitNoActiveRuns(Duration.millis(timeoutMs), "cold").pipe(
      Effect.provide(context),
      Effect.mapError(toDrainError),
    );
    const current = yield* status;
    return {
      ...current,
      idle: result.drained && current.activeRunIds.length === 0,
      waitedMs: Math.max(0, Math.round(result.waitedMs)),
    } satisfies ServerDrainWaitResult;
  });

  return ServerDrain.of({ set, status, wait });
});

export const layer = Layer.effect(ServerDrain, make);
