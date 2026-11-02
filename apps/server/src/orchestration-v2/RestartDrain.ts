import {
  ServerPrepareRestartError,
  type OrchestrationV2Run,
  type RunId,
  type ServerRestartDrain,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const executing = (status: OrchestrationV2Run["status"]) =>
  status === "running" || status === "preparing";

export const restartPausedRunIds = (projection: ProjectionStore.ProjectionRuntimeRecoveryState) => {
  const pendingNodeIds = new Set(
    projection.runtimeRequests
      .filter(
        (request) =>
          request.status === "pending" &&
          request.kind !== "dynamic_tool_call" &&
          request.kind !== "auth_refresh",
      )
      .map((request) => request.nodeId),
  );
  const paused = new Set(
    projection.nodes.filter((node) => pendingNodeIds.has(node.id)).map((node) => node.runId),
  );
  for (const item of projection.turnItems) {
    if (item.type === "secret_request" && item.secretStatus === "pending") paused.add(item.runId);
  }
  return projection.runs.filter((run) => paused.has(run.id)).map((run) => run.id);
};

const activeRuns = Effect.fn("RestartDrain.activeRuns")(function* () {
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return yield* outbox
    .withTransaction(
      Effect.gen(function* () {
        const startsInFlight = new Set(
          (yield* outbox.unsettledEffects([
            "provider-turn.start",
            "provider-turn.restart",
          ])).flatMap((effect) =>
            effect.request.type === "provider-turn.restart" ||
            (effect.request.type === "provider-turn.start" && effect.status === "running")
              ? [effect.request.runId]
              : [],
          ),
        );
        const active = new Set<RunId>();
        for (const threadId of yield* projections.getRecoveryThreadIds("runtime")) {
          const projection = yield* projections.getRuntimeRecoveryProjection(threadId);
          const paused = new Set(restartPausedRunIds(projection));
          for (const run of projection.runs) {
            if (
              !paused.has(run.id) &&
              (executing(run.status) || (run.status === "starting" && startsInFlight.has(run.id)))
            )
              active.add(run.id);
          }
        }
        return active;
      }),
    )
    .pipe(NodeSqliteClient.readOnly);
});

export const drainBeforeRestart = Effect.fn("RestartDrain.drainBeforeRestart")(function* (
  epoch: string,
  deadline: Duration.Duration,
) {
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const startedAt = yield* Clock.currentTimeMillis;
  yield* outbox.drainForRestart(epoch);
  const settled = yield* Effect.gen(function* () {
    let active = yield* activeRuns();
    while (true) {
      if (active.size === 0) {
        active = yield* activeRuns();
        if (active.size === 0) return active;
      }
      yield* Effect.sleep(Duration.millis(250));
      active = yield* activeRuns();
    }
  }).pipe(Effect.timeoutOption(deadline));
  const remaining = Option.isSome(settled) ? [] : [...(yield* activeRuns())];
  return {
    drained: remaining.length === 0,
    waitedMs: (yield* Clock.currentTimeMillis) - startedAt,
    activeRunIds: remaining,
  } satisfies ServerRestartDrain;
});

export const awaitRestartEffects = Effect.fn("RestartDrain.awaitRestartEffects")(function* () {
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  yield* Effect.forEach(yield* outbox.runningEffects, (effect) => outbox.awaitSettled(effect.id), {
    concurrency: "unbounded",
    discard: true,
  });
});

export const makeHandoffDrain = Effect.gen(function* () {
  const owner = yield* Effect.scope;
  let hold: { epoch: string; scope: Scope.Closeable } | undefined;
  const release = Effect.fn("RestartDrain.releaseHandoff")(function* (epoch: string) {
    if (hold?.epoch !== epoch) return;
    const { scope } = hold;
    hold = undefined;
    yield* Scope.close(scope, Exit.void);
  }, Effect.uninterruptible);
  const drain = Effect.fn("RestartDrain.drainForHandoff")(
    function* (epoch: string, timeoutMs: number) {
      if (hold !== undefined && hold.epoch !== epoch) {
        yield* Effect.logWarning("Releasing stale service handoff drain", {
          epoch: hold.epoch,
          nextEpoch: epoch,
        });
        yield* release(hold.epoch);
      }
      hold ??= { epoch, scope: yield* Scope.fork(owner, "sequential") };
      const result = yield* drainBeforeRestart(epoch, Duration.millis(timeoutMs)).pipe(
        Effect.provideService(Scope.Scope, hold.scope),
        Effect.onError(() => release(epoch)),
      );
      if (!result.drained)
        yield* Effect.logInfo("Service handoff drain deadline reached", {
          epoch,
          activeRuns: result.activeRunIds.length,
        });
    },
    Effect.mapError((cause) => new ServerPrepareRestartError({ cause })),
  );
  return { drain, release };
});
