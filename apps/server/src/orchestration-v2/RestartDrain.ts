import {
  ServerPrepareRestartError,
  type OrchestrationV2Run,
  type RunId,
  type ServerRestartDrain,
  type ThreadId,
  isOrchestrationV2WorkActive,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const executing = {
  preparing: true,
  queued: false,
  starting: true,
  running: true,
  waiting: false,
  completed: false,
  interrupted: false,
  failed: false,
  cancelled: false,
  rolled_back: false,
} satisfies Record<OrchestrationV2Run["status"], boolean>;

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
  return projection.runs.filter((run) => paused.has(run.id)).map((run) => run.id);
};

const activeRuns = Effect.fn("RestartDrain.activeRuns")(function* (
  mode: "hot-swap" | "cold",
  threadIds?: ReadonlySet<ThreadId>,
) {
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return yield* outbox
    .withTransaction(
      Effect.gen(function* () {
        const unsettled = yield* outbox.unsettledEffects([
          "provider-turn.start",
          "provider-turn.restart",
          "checkpoint.capture",
        ]);
        const heldStarts = new Set(
          unsettled.flatMap((effect) =>
            effect.request.type === "provider-turn.start" && effect.status === "pending"
              ? [effect.request.runId]
              : [],
          ),
        );
        const effectsInFlight = new Set(
          unsettled.flatMap((effect) =>
            effect.request.type === "checkpoint.capture" ||
            effect.request.type === "provider-turn.restart" ||
            (effect.request.type === "provider-turn.start" && effect.status === "running")
              ? [effect.request.runId]
              : [],
          ),
        );
        const active = new Map<ThreadId, RunId[]>();
        for (const threadId of threadIds ?? (yield* projections.getRecoveryThreadIds("runtime"))) {
          const projection = yield* projections.getRuntimeRecoveryProjection(threadId);
          const paused = new Set(restartPausedRunIds(projection));
          const secretRuns = new Set(
            projection.turnItems.flatMap((item) =>
              item.type === "secret_request" &&
              item.secretStatus === "pending" &&
              item.runId !== null
                ? [item.runId]
                : [],
            ),
          );
          const workInFlight = new Set(
            projection.turnItems
              .filter(
                (item) =>
                  (item.type === "command_execution" ||
                    item.type === "dynamic_tool" ||
                    item.type === "subagent") &&
                  isOrchestrationV2WorkActive(item.status),
              )
              .map((item) => item.runId),
          );
          for (const task of projection.subagents) {
            if (isOrchestrationV2WorkActive(task.status)) workInFlight.add(task.runId);
          }
          for (const runId of secretRuns) {
            if (workInFlight.has(runId) || effectsInFlight.has(runId)) secretRuns.delete(runId);
          }
          const activeNodeIds = new Set(
            projection.providerTurns
              .filter((turn) => isOrchestrationV2WorkActive(turn.status))
              .map((turn) => turn.nodeId),
          );
          for (const thread of projection.providerThreads) {
            if (thread.ownerNodeId !== null && (thread.pendingBackgroundTasks?.length ?? 0) > 0) {
              activeNodeIds.add(thread.ownerNodeId);
              const runId = projection.nodes.find((node) => node.id === thread.ownerNodeId)?.runId;
              if (runId != null) secretRuns.delete(runId);
            }
          }
          for (const node of projection.nodes) {
            if (activeNodeIds.has(node.id)) workInFlight.add(node.runId);
          }
          for (const run of projection.runs) {
            if (
              !(mode === "hot-swap" && (paused.has(run.id) || secretRuns.has(run.id))) &&
              ((executing[run.status] &&
                !(
                  run.status === "starting" &&
                  heldStarts.has(run.id) &&
                  !effectsInFlight.has(run.id)
                )) ||
                (run.status === "waiting" &&
                  (effectsInFlight.has(run.id) ||
                    paused.has(run.id) ||
                    secretRuns.has(run.id) ||
                    workInFlight.has(run.id))))
            )
              active.set(threadId, [...(active.get(threadId) ?? []), run.id]);
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
  mode: "hot-swap" | "cold",
) {
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const sink = yield* EventSink.EventSinkV2;
  const startedAt = yield* Clock.currentTimeMillis;
  yield* outbox.drainForRestart(epoch);
  const settled = yield* Effect.scoped(
    Effect.gen(function* () {
      const wakes = yield* Queue.sliding<void>(1);
      const pending = yield* Ref.make({ full: false, threadIds: new Set<ThreadId>() });
      const afterSequence = yield* sink.latestSequence();
      yield* sink.stream({ afterSequence }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "run.created" ||
            event.type === "run.updated" ||
            event.type === "node.updated" ||
            event.type === "runtime-request.updated" ||
            (event.type === "turn-item.updated" && event.payload.type === "secret_request"),
        ),
        Stream.runForEach(({ event }) =>
          Ref.update(pending, (current) => ({
            ...current,
            threadIds: new Set([...current.threadIds, event.threadId]),
          })).pipe(Effect.andThen(Queue.offer(wakes, undefined))),
        ),
        Effect.forkScoped,
      );
      yield* Ref.update(pending, (current) => ({ ...current, full: true })).pipe(
        Effect.andThen(Queue.offer(wakes, undefined)),
        Effect.repeat(Schedule.spaced("5 seconds")),
        Effect.delay("5 seconds"),
        Effect.forkScoped,
      );
      const active = yield* Ref.make(yield* activeRuns(mode));
      if ((yield* Ref.get(active)).size === 0) return;
      yield* Effect.gen(function* () {
        yield* Queue.take(wakes);
        const wake = yield* Ref.getAndSet(pending, { full: false, threadIds: new Set<ThreadId>() });
        const threadIds = new Set([...(yield* Ref.get(active)).keys(), ...wake.threadIds]);
        const next = yield* activeRuns(mode, wake.full ? undefined : threadIds);
        const confirmed = next.size === 0 && !wake.full ? yield* activeRuns(mode) : next;
        yield* Ref.set(active, confirmed);
        return confirmed.size === 0;
      }).pipe(Effect.repeat({ schedule: Schedule.spaced("250 millis"), until: (done) => done }));
    }),
  ).pipe(Effect.timeoutOption(deadline));
  const remaining = Option.isSome(settled) ? [] : [...(yield* activeRuns(mode)).values()].flat();
  yield* Effect.annotateCurrentSpan({ mode, drained: remaining.length === 0 });
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
      const result = yield* drainBeforeRestart(epoch, Duration.millis(timeoutMs), "hot-swap").pipe(
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
