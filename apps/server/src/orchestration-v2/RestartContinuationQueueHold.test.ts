import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";

const threadId = ThreadId.make("thread:restart-hold");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread:restart-hold");
const sessionId = ProviderSessionId.make("session:restart-hold");
const attemptId = RunAttemptId.make("attempt:restart-hold");
const now = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z");

const cutRun = {
  id: RunId.make("run:cut"),
  ordinal: 1,
  userMessageId: MessageId.make("message:cut"),
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-6" },
  providerThreadId,
  activeAttemptId: attemptId,
  status: "running",
  requestedAt: now,
  startedAt: now,
  completedAt: null,
};
const queuedRun = {
  id: RunId.make("run:queued"),
  ordinal: 2,
  userMessageId: MessageId.make("message:queued"),
  providerInstanceId: instanceId,
  providerThreadId,
  status: "queued",
  queueHeld: true,
  queueHoldReason: "restart",
};

const projectionWith = (runs: ReadonlyArray<object>, thread: object = {}, turnStatus = "running") =>
  ({
    thread: {
      id: threadId,
      projectId: ProjectId.make("project:restart-hold"),
      providerInstanceId: instanceId,
      archivedAt: null,
      deletedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      ...thread,
    },
    runs,
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        status: "active",
      },
    ],
    providerSessions: [
      { id: sessionId, driver, providerInstanceId: instanceId, status: "running" },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("turn:restart-hold"),
        providerThreadId,
        runAttemptId: attemptId,
        status: turnStatus,
      },
    ],
    runtimeRequests: [],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  }) as unknown as OrchestrationV2ThreadProjection;

const startupCommit = (
  projection: OrchestrationV2ThreadProjection,
  continuation?: "pending" | "succeeded",
  threadRuns = projection.runs,
) =>
  Effect.gen(function* () {
    let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            getMessagesById: () => Effect.succeed(new Map()),
            getThreadRecords: () => Effect.succeed({ runs: threadRuns } as never),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committed = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            get: () =>
              Effect.succeed(
                continuation === undefined
                  ? Option.none()
                  : Option.some({ status: continuation } as EffectOutbox.OrchestrationEffectV2),
              ),
            cancelUnsettled: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.reconcile("startup");
    return {
      continues: committed?.effects.map((effect) => effect.request.type) ?? [],
      released: (committed?.events ?? []).flatMap((event) =>
        event.type === "run.updated" && event.runId === queuedRun.id
          ? [event.payload.queueHeld]
          : [],
      ),
    };
  });

it.effect("keeps queued follow-ups held until a cut run's continuation settles", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* startupCommit(projectionWith([cutRun, queuedRun])), {
      continues: ["provider-runtime.continue"],
      released: [],
    });
    const cancelled = { ...cutRun, status: "cancelled", completedAt: now };
    for (const continuation of ["pending", "succeeded"] as const)
      assert.deepEqual(
        (yield* startupCommit(projectionWith([queuedRun], {}, "cancelled"), continuation, [
          cancelled,
          queuedRun,
        ] as unknown as OrchestrationV2ThreadProjection["runs"])).released,
        continuation === "pending" ? [] : [false],
      );
  }),
);

it.effect("releases queued follow-ups at startup on a snoozed or settled thread", () =>
  Effect.gen(function* () {
    for (const thread of [
      { snoozedUntil: DateTime.add(now, { days: 1 }) },
      { settledOverride: "settled" },
    ])
      assert.deepEqual(yield* startupCommit(projectionWith([cutRun, queuedRun], thread)), {
        continues: [],
        released: [false],
      });
  }),
);
