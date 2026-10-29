import {
  type OrchestrationV2Run,
  type RunId,
  ServerPrepareRestartError,
  type ServerRestartDrain,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const executing = (status: OrchestrationV2Run["status"]) =>
  status === "running" || status === "preparing";

const pending = (status: OrchestrationV2Run["status"]) =>
  status === "starting" || status === "queued";

const activeRuns = Effect.gen(function* () {
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const startsInFlight = new Set(
    (yield* outbox.unsettledEffects(["provider-turn.start", "provider-turn.restart"])).flatMap(
      (effect) =>
        effect.request.type === "provider-turn.restart" ||
        (effect.request.type === "provider-turn.start" && effect.status === "running")
          ? [effect.request.runId]
          : [],
    ),
  );
  const active = new Set<RunId>();
  for (const threadId of yield* projections.getRecoveryThreadIds("runtime")) {
    const { runs } = yield* projections.getRuntimeRecoveryProjection(threadId);
    for (const run of runs) {
      if (executing(run.status) || (run.status === "starting" && startsInFlight.has(run.id)))
        active.add(run.id);
    }
  }
  return active;
});

export const drainBeforeRestart = Effect.fn("RestartDrain.drainBeforeRestart")(function* (
  epoch: string,
  deadline: Duration.Duration,
) {
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const sink = yield* EventSink.EventSinkV2;
  const startedAt = yield* Clock.currentTimeMillis;
  if (!(yield* outbox.drainForRestart(epoch)))
    return yield* new ServerPrepareRestartError({ cause: "A restart drain is already running." });
  const afterSequence = yield* sink.latestSequence();
  const initial = yield* activeRuns;
  const settled =
    initial.size === 0
      ? Option.some(initial)
      : yield* sink.stream({ afterSequence, eventType: "run.updated" }).pipe(
          Stream.scan(
            () => initial,
            (active: ReadonlySet<RunId>, stored) => {
              if (stored.event.type !== "run.updated") return active;
              const next = new Set(active);
              const { id, status } = stored.event.payload;
              if (executing(status)) next.add(id);
              else if (!pending(status)) next.delete(id);
              return next;
            },
          ),
          Stream.filter((active) => active.size === 0),
          Stream.runHead,
          Effect.timeoutOption(deadline),
          Effect.map(Option.flatten),
        );
  const remaining = Option.isSome(settled) ? [] : [...(yield* activeRuns)];
  return {
    drained: remaining.length === 0,
    waitedMs: (yield* Clock.currentTimeMillis) - startedAt,
    activeRunIds: remaining,
  } satisfies ServerRestartDrain;
});
