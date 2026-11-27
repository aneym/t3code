import {
  CommandId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { transientBlockedQueueResumePlan, wakesBlockedQueue } from "./QueueHoldPolicy.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const ATTEMPTED_LIMIT = 2_000;

function healthyProviderInstances(
  providers: ReadonlyArray<ServerProvider>,
): Set<ProviderInstanceId> {
  return new Set(
    providers
      .filter((provider) => provider.status === "ready" || provider.status === "warning")
      .map((provider) => provider.instanceId),
  );
}

function recoveredProviderInstances(
  healthyBefore: ReadonlySet<ProviderInstanceId>,
  providers: ReadonlyArray<ServerProvider>,
) {
  const healthy = healthyProviderInstances(providers);
  return { healthy, recovered: [...healthy].filter((id) => !healthyBefore.has(id)) };
}

const affectsBlockedQueueResume = (event: OrchestrationV2DomainEvent) =>
  event.type === "run.updated" ||
  event.type === "run.created" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("thread.") ||
  event.type.startsWith("provider-session.");

const makeWake = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  return Effect.fn("BlockedQueueWakeWorker.wake")(function* (
    instances: ReadonlyArray<ProviderInstanceId>,
  ) {
    if (instances.length === 0) return;
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs
      WHERE status = 'queued'
        AND json_extract(payload_json, '$.queueHoldReason') = 'blocked'
    `;
    for (const row of rows) {
      const threadId = ThreadId.make(row.thread_id);
      yield* Effect.gen(function* () {
        const projection = yield* projections.getThreadRecords(threadId, ["runs"]);
        const instance = instances.find((id) => wakesBlockedQueue(projection, id));
        if (instance === undefined) return;
        const heldAt = projection.runs.find(
          (run) => run.status === "queued" && run.queueHeldAt !== undefined,
        )?.queueHeldAt;
        const stamp = heldAt === undefined ? "unstamped" : DateTime.formatIso(heldAt);
        yield* Effect.logInfo("orchestration-v2.blocked-queue.wake", {
          threadId,
          providerInstanceId: instance,
          heldAt: stamp,
        });
        yield* threads.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`command:system:queue-wake:${threadId}:${stamp}`),
          threadId,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.blocked-queue.wake-failed", { threadId, cause }),
        ),
      );
    }
  });
});

const makeAutoResumeSweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const due = DueHint.make();
  const attempted = new Set<string>();

  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsBlockedQueueResume(event) ? due.invalidate : Effect.void,
    ),
  );

  const sweep = Effect.fn("BlockedQueueWakeWorker.autoResumeSweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const healthyIds = healthyProviderInstances(yield* registry.getProviders);
    if (healthyIds.size === 0) {
      yield* due.record(readVersion, Number.POSITIVE_INFINITY, nowMs);
      return;
    }
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs
      WHERE status = 'queued'
        AND json_extract(payload_json, '$.queueHoldReason') = 'blocked'
    `;
    let acted = false;
    let nextWakeAt = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      const threadId = ThreadId.make(row.thread_id);
      yield* Effect.gen(function* () {
        const projection = yield* projections.getThreadRecords(
          threadId,
          ["runs", "turnItems", "runtimeRequests", "providerSessions"],
          { turnItemTypes: ["error"] },
        );
        const plan = transientBlockedQueueResumePlan(projection, healthyIds, nowMs);
        if (plan.status === "skip") return;
        if (plan.status === "wait") {
          nextWakeAt = Math.min(nextWakeAt, plan.dueAtMs);
          return;
        }
        const stamp = DateTime.formatIso(plan.heldAt);
        const key = `${threadId}:${stamp}:${plan.attempt}`;
        if (attempted.has(key)) return;
        attempted.add(key);
        if (attempted.size > ATTEMPTED_LIMIT) attempted.delete(attempted.values().next().value!);
        acted = true;
        yield* Effect.logInfo("orchestration-v2.blocked-queue.auto-resume", {
          threadId,
          providerInstanceId: plan.providerInstanceId,
          heldAt: stamp,
          attempt: plan.attempt,
          failureClass: plan.failureClass,
        });
        yield* threads.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(
            `command:system:queue-auto-resume:${threadId}:${stamp}:${plan.attempt}`,
          ),
          threadId,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.blocked-queue.auto-resume-failed", {
            threadId,
            cause,
          }),
        ),
      );
    }
    if (acted) return;
    yield* due.record(readVersion, nextWakeAt, nowMs);
  });

  return { sweep, invalidate: due.invalidate };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const wake = yield* makeWake;
    const autoResume = yield* makeAutoResumeSweep;
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const scheduler = yield* Scheduler.Scheduler;
    let healthy: ReadonlySet<ProviderInstanceId> = healthyProviderInstances(
      yield* registry.getProviders,
    );
    yield* scheduler.register("blocked-queue-auto-resume", autoResume.sweep());
    yield* forkParked(
      Stream.runForEach(registry.streamChanges, (providers) => {
        const next = recoveredProviderInstances(healthy, providers);
        healthy = next.healthy;
        return autoResume.invalidate.pipe(
          Effect.andThen(wake(next.recovered)),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.blocked-queue.sweep-failed", { cause }),
          ),
        );
      }),
    );
  }),
);
