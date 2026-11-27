import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailureClass,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as BlockedQueueWakeWorker from "./BlockedQueueWakeWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  TRANSIENT_QUEUE_RESUME_BASE_DELAY_MS,
  TRANSIENT_QUEUE_RESUME_MAX_ATTEMPTS,
  transientBlockedQueueResumePlan,
  transientQueueResumeDelayMs,
} from "./QueueHoldPolicy.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const INSTANCE = ProviderInstanceId.make("claudeAgent");
const HEALTHY = new Set([INSTANCE]);
const BASE_MS = Date.parse("2026-11-26T20:00:00.000Z");

const at = (offsetMs: number) => DateTime.makeUnsafe(BASE_MS + offsetMs);

function makeRun(
  overrides: Partial<OrchestrationV2Run> & { readonly id: RunId; readonly ordinal: number },
): OrchestrationV2Run {
  return {
    threadId: ThreadId.make("thread:transient"),
    providerInstanceId: INSTANCE,
    modelSelection: { instanceId: INSTANCE, model: "claude-opus-5-5" },
    providerThreadId: ProviderThreadId.make("provider-thread:1"),
    userMessageId: MessageId.make(`msg:${overrides.ordinal}`),
    rootNodeId: NodeId.make(`node:${overrides.ordinal}`),
    activeAttemptId: RunAttemptId.make(`attempt:${overrides.ordinal}`),
    status: "queued",
    requestedAt: at(0),
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    ...overrides,
  };
}

function makeErrorItem(
  runId: RunId,
  ordinal: number,
  failureClass: OrchestrationV2ProviderFailureClass,
  updatedAtMs: number,
): Extract<OrchestrationV2TurnItem, { type: "error" }> {
  const ts = DateTime.makeUnsafe(updatedAtMs);
  return {
    id: TurnItemId.make(`item:err:${ordinal}`),
    threadId: ThreadId.make("thread:transient"),
    runId,
    nodeId: NodeId.make(`node:${ordinal}`),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    type: "error",
    status: "failed",
    title: null,
    failure: {
      class: failureClass,
      message: `${failureClass} failure`,
      code: null,
      retryable: true,
    },
    startedAt: null,
    completedAt: ts,
    updatedAt: ts,
  };
}

function makeThread(
  threadId: ThreadId,
  overrides: Partial<OrchestrationV2ThreadProjection["thread"]> = {},
): OrchestrationV2ThreadProjection["thread"] {
  return {
    id: threadId,
    projectId: ProjectId.make("project:1"),
    title: threadId,
    providerInstanceId: INSTANCE,
    modelSelection: { instanceId: INSTANCE, model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    lastVisitedAt: null,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  };
}

function makeProjection(input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems?: OrchestrationV2ThreadProjection["turnItems"];
  readonly runtimeRequests?: OrchestrationV2ThreadProjection["runtimeRequests"];
  readonly thread?: Partial<OrchestrationV2ThreadProjection["thread"]>;
}): Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "turnItems" | "runtimeRequests" | "providerSessions"
> {
  return {
    thread: makeThread(ThreadId.make("thread:transient"), input.thread),
    runs: input.runs,
    turnItems: input.turnItems ?? [],
    runtimeRequests: input.runtimeRequests ?? [],
    providerSessions: [],
  };
}

describe("transientBlockedQueueResumePlan", () => {
  it("schedules exponential backoff for transient failures and stops cleanly at max attempts", () => {
    const failedRuns: Array<OrchestrationV2Run> = [];
    const errorItems: Array<ReturnType<typeof makeErrorItem>> = [];

    for (let attempt = 0; attempt < TRANSIENT_QUEUE_RESUME_MAX_ATTEMPTS; attempt++) {
      const ordinal = attempt + 1;
      const runId = RunId.make(`run:failed:${ordinal}`);
      const failedAtMs = BASE_MS + ordinal * 10_000;
      const failureClass = attempt % 2 === 0 ? "transport_error" : "provider_error";
      failedRuns.push(
        makeRun({
          id: runId,
          ordinal,
          status: "failed",
          startedAt: DateTime.makeUnsafe(failedAtMs - 1_000),
          completedAt: DateTime.makeUnsafe(failedAtMs),
        }),
      );
      errorItems.push(makeErrorItem(runId, ordinal, failureClass, failedAtMs));

      const heldRun = makeRun({
        id: RunId.make(`run:queued:${ordinal}`),
        ordinal: ordinal + 10,
        status: "queued",
        queueHeld: true,
        queueHoldReason: "blocked",
        queueHeldAt: DateTime.makeUnsafe(failedAtMs),
        queueHoldFailureClass: failureClass,
      });

      const expectedDelay = transientQueueResumeDelayMs(attempt);
      const before = transientBlockedQueueResumePlan(
        makeProjection({ runs: [...failedRuns, heldRun], turnItems: errorItems }),
        HEALTHY,
        failedAtMs + expectedDelay - 1,
      );
      assert.equal(before.status, "wait");
      if (before.status === "wait") {
        assert.equal(before.dueAtMs, failedAtMs + expectedDelay);
        assert.equal(before.attempt, attempt + 1);
      }

      const due = transientBlockedQueueResumePlan(
        makeProjection({ runs: [...failedRuns, heldRun], turnItems: errorItems }),
        HEALTHY,
        failedAtMs + expectedDelay,
      );
      assert.equal(due.status, "due");
      if (due.status === "due") {
        assert.equal(due.attempt, attempt + 1);
      }
    }

    const finalOrdinal = TRANSIENT_QUEUE_RESUME_MAX_ATTEMPTS + 1;
    const finalRunId = RunId.make(`run:failed:${finalOrdinal}`);
    const finalFailedAtMs = BASE_MS + finalOrdinal * 10_000;
    failedRuns.push(
      makeRun({
        id: finalRunId,
        ordinal: finalOrdinal,
        status: "failed",
        startedAt: DateTime.makeUnsafe(finalFailedAtMs - 1_000),
        completedAt: DateTime.makeUnsafe(finalFailedAtMs),
      }),
    );
    errorItems.push(makeErrorItem(finalRunId, finalOrdinal, "provider_error", finalFailedAtMs));

    const exhaustedRun = makeRun({
      id: RunId.make("run:queued:exhausted"),
      ordinal: 99,
      status: "queued",
      queueHeld: true,
      queueHoldReason: "blocked",
      queueHeldAt: DateTime.makeUnsafe(finalFailedAtMs),
      queueHoldFailureClass: "provider_error",
    });

    const exhausted = transientBlockedQueueResumePlan(
      makeProjection({ runs: [...failedRuns, exhaustedRun], turnItems: errorItems }),
      HEALTHY,
      finalFailedAtMs + 24 * 60 * 60 * 1_000,
    );
    assert.equal(exhausted.status, "skip");
  });

  it("never auto-resumes explicit stop, manual, restart, or non-transient holds", () => {
    const cases: ReadonlyArray<Partial<OrchestrationV2Run>> = [
      { queueHoldReason: "stop", queueHeldAt: at(0) },
      { queueHoldReason: "restart", queueHeldAt: at(0) },
      { queueHoldReason: undefined, queueHeldAt: at(0) },
      { queueHoldReason: "blocked", queueHeldAt: at(0), queueHoldFailureClass: undefined },
      { queueHoldReason: "blocked", queueHeldAt: at(0), queueHoldFailureClass: "usage_limit" },
      { queueHoldReason: "blocked", queueHeldAt: at(0), queueHoldFailureClass: "permission_error" },
      { queueHoldReason: "blocked", queueHeldAt: at(0), queueHoldFailureClass: "unknown" },
    ];

    for (const [index, hold] of cases.entries()) {
      const queued = makeRun({
        id: RunId.make(`run:non-resumable:${index}`),
        ordinal: 2,
        status: "queued",
        queueHeld: true,
        ...hold,
      });
      const plan = transientBlockedQueueResumePlan(
        makeProjection({ runs: [queued] }),
        HEALTHY,
        BASE_MS + 60 * 60 * 1_000,
      );
      assert.equal(plan.status, "skip");
    }
  });

  it("resets retry streak after a completed run and respects snooze", () => {
    const runs = [
      makeRun({
        id: RunId.make("r1"),
        ordinal: 1,
        status: "failed",
        startedAt: at(1),
        completedAt: at(2),
      }),
      makeRun({
        id: RunId.make("r2"),
        ordinal: 2,
        status: "failed",
        startedAt: at(3),
        completedAt: at(4),
      }),
      makeRun({
        id: RunId.make("r3"),
        ordinal: 3,
        status: "failed",
        startedAt: at(5),
        completedAt: at(6),
      }),
      makeRun({
        id: RunId.make("r4"),
        ordinal: 4,
        status: "completed",
        startedAt: at(7),
        completedAt: at(8),
      }),
      makeRun({
        id: RunId.make("r5"),
        ordinal: 5,
        status: "failed",
        startedAt: at(9),
        completedAt: at(10),
      }),
      makeRun({
        id: RunId.make("r6"),
        ordinal: 6,
        status: "queued",
        queueHeld: true,
        queueHoldReason: "blocked",
        queueHeldAt: at(10),
        queueHoldFailureClass: "provider_error",
      }),
    ];
    const items = [
      makeErrorItem(RunId.make("r1"), 1, "provider_error", BASE_MS + 2),
      makeErrorItem(RunId.make("r2"), 2, "provider_error", BASE_MS + 4),
      makeErrorItem(RunId.make("r3"), 3, "provider_error", BASE_MS + 6),
      makeErrorItem(RunId.make("r5"), 5, "provider_error", BASE_MS + 10),
    ];

    const plan = transientBlockedQueueResumePlan(
      makeProjection({ runs, turnItems: items }),
      HEALTHY,
      BASE_MS + 10 + TRANSIENT_QUEUE_RESUME_BASE_DELAY_MS,
    );
    assert.equal(plan.status, "due");
    if (plan.status === "due") assert.equal(plan.attempt, 1);

    const snoozed = transientBlockedQueueResumePlan(
      makeProjection({
        runs,
        turnItems: items,
        thread: { snoozedUntil: at(120_000) },
      }),
      HEALTHY,
      BASE_MS + 10 + TRANSIENT_QUEUE_RESUME_BASE_DELAY_MS,
    );
    assert.equal(snoozed.status, "wait");
    if (snoozed.status === "wait") assert.equal(snoozed.dueAtMs, BASE_MS + 120_000);
  });
});

const readyProvider: ServerProvider = {
  instanceId: INSTANCE,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  models: [],
} as unknown as ServerProvider;

describe("BlockedQueueWakeWorker integration", () => {
  it.effect(
    "auto-resumes transient blocked holds after backoff, stops after max retries, and never resumes stop holds",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(BASE_MS);
        const dispatched: Array<
          Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0]
        > = [];
        const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const persistenceLayer = ProjectionStore.layer.pipe(
          Layer.provideMerge(SqlitePersistence.layerMemory),
        );
        const workerDeps = Layer.mergeAll(
          persistenceLayer,
          Scheduler.layer,
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([readyProvider]),
            streamChanges: Stream.never,
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
              }).pipe(Effect.as({} as never)),
          }),
        );
        const testLayer = Layer.mergeAll(
          persistenceLayer,
          BlockedQueueWakeWorker.layer.pipe(Layer.provide(workerDeps)),
        );

        yield* Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const transientThreadId = ThreadId.make("thread:transient-worker");
          const stoppedThreadId = ThreadId.make("thread:stopped-worker");
          const exhaustedThreadId = ThreadId.make("thread:exhausted-worker");

          for (const threadId of [transientThreadId, stoppedThreadId, exhaustedThreadId]) {
            yield* projections.apply({
              id: EventId.make(`ev:create:${threadId}`),
              type: "thread.created",
              threadId,
              occurredAt: at(0),
              payload: makeThread(threadId, { projectId: ProjectId.make("project:worker") }),
            });
          }

          const seedRun = (run: OrchestrationV2Run, occurredAt = at(0)) =>
            projections.apply({
              id: EventId.make(`ev:run:${run.id}`),
              type: "run.created",
              threadId: run.threadId,
              runId: run.id,
              providerInstanceId: INSTANCE,
              occurredAt,
              payload: run,
            });

          const seedFailedRun = (
            threadId: ThreadId,
            ordinal: number,
            completedAtMs: number,
            failureClass: OrchestrationV2ProviderFailureClass,
          ) =>
            Effect.gen(function* () {
              const runId = RunId.make(`run:${threadId}:fail:${ordinal}`);
              const run = makeRun({
                id: runId,
                threadId,
                ordinal,
                status: "failed",
                startedAt: DateTime.makeUnsafe(completedAtMs - 1_000),
                completedAt: DateTime.makeUnsafe(completedAtMs),
              });
              yield* seedRun(run, DateTime.makeUnsafe(completedAtMs));
              yield* projections.apply({
                id: EventId.make(`ev:err:${runId}`),
                type: "turn-item.updated",
                threadId,
                runId,
                nodeId: run.rootNodeId!,
                providerInstanceId: INSTANCE,
                occurredAt: DateTime.makeUnsafe(completedAtMs),
                payload: {
                  ...makeErrorItem(runId, ordinal, failureClass, completedAtMs),
                  id: TurnItemId.make(`item:${threadId}:err:${ordinal}`),
                  threadId,
                },
              });
            });

          yield* seedFailedRun(transientThreadId, 1, BASE_MS, "transport_error");
          const transientQueued = makeRun({
            id: RunId.make("run:transient:queued"),
            threadId: transientThreadId,
            ordinal: 2,
            status: "queued",
            queueHeld: true,
            queueHoldReason: "blocked",
            queueHeldAt: at(0),
            queueHoldFailureClass: "transport_error",
          });
          yield* seedRun(transientQueued);

          yield* seedRun(
            makeRun({
              id: RunId.make("run:stopped:queued"),
              threadId: stoppedThreadId,
              ordinal: 1,
              status: "queued",
              queueHeld: true,
              queueHoldReason: "stop",
              queueHeldAt: at(0),
            }),
          );

          for (let i = 1; i <= TRANSIENT_QUEUE_RESUME_MAX_ATTEMPTS + 1; i++) {
            yield* seedFailedRun(
              exhaustedThreadId,
              i,
              BASE_MS - 60_000 + i * 1_000,
              "provider_error",
            );
          }
          yield* seedRun(
            makeRun({
              id: RunId.make("run:exhausted:queued"),
              threadId: exhaustedThreadId,
              ordinal: 10,
              status: "queued",
              queueHeld: true,
              queueHoldReason: "blocked",
              queueHeldAt: at(0),
              queueHoldFailureClass: "provider_error",
            }),
          );

          yield* Queue.offer(events, {
            type: "run.updated",
            payload: transientQueued,
          } as never);

          yield* TestClock.adjust("25 seconds");
          assert.deepEqual(dispatched, []);

          yield* TestClock.adjust("5 seconds");
          assert.equal(dispatched.length, 1);
          const first = dispatched[0]!;
          assert.equal(first.type, "queue.resume");
          if (first.type === "queue.resume") {
            assert.equal(first.threadId, transientThreadId);
          }

          yield* projections.apply({
            id: EventId.make("ev:transient:run2:failed"),
            type: "run.updated",
            threadId: transientThreadId,
            runId: transientQueued.id,
            providerInstanceId: INSTANCE,
            occurredAt: at(30_000),
            payload: {
              ...transientQueued,
              status: "failed",
              queueHeld: false,
              queueHoldReason: undefined,
              queueHeldAt: undefined,
              queueHoldFailureClass: undefined,
              startedAt: at(30_000),
              completedAt: at(30_000),
            },
          });
          yield* projections.apply({
            id: EventId.make("ev:transient:run2:err"),
            type: "turn-item.updated",
            threadId: transientThreadId,
            runId: transientQueued.id,
            nodeId: transientQueued.rootNodeId!,
            providerInstanceId: INSTANCE,
            occurredAt: at(30_000),
            payload: {
              ...makeErrorItem(transientQueued.id, 2, "provider_error", BASE_MS + 30_000),
              id: TurnItemId.make(`item:${transientThreadId}:err:2`),
              threadId: transientThreadId,
            },
          });
          const transientQueued2 = makeRun({
            id: RunId.make("run:transient:queued:2"),
            threadId: transientThreadId,
            ordinal: 3,
            status: "queued",
            queueHeld: true,
            queueHoldReason: "blocked",
            queueHeldAt: at(30_000),
            queueHoldFailureClass: "provider_error",
          });
          yield* projections.apply({
            id: EventId.make("ev:transient:queued:2"),
            type: "run.created",
            threadId: transientThreadId,
            runId: transientQueued2.id,
            providerInstanceId: INSTANCE,
            occurredAt: at(30_000),
            payload: transientQueued2,
          });
          yield* Queue.offer(events, {
            type: "run.updated",
            payload: transientQueued2,
          } as never);

          yield* TestClock.adjust("55 seconds");
          assert.equal(dispatched.length, 1);

          yield* TestClock.adjust("5 seconds");
          assert.equal(dispatched.length, 2);
          const second = dispatched[1]!;
          assert.equal(second.type, "queue.resume");
          if (second.type === "queue.resume") {
            assert.equal(second.threadId, transientThreadId);
          }

          yield* TestClock.adjust("10 minutes");
          assert.equal(dispatched.length, 2);
        }).pipe(Effect.provide(testLayer));
      }),
  );
});
