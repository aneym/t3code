import {
  nonterminalRuns,
  isBackgroundCapableTurnItemType,
  isNonterminalTurnItemStatus,
  isAppOwnedDelegation,
  isAppOwnedDelegationItem,
  providerThreadHasPendingBackgroundTasks,
  resolveStaleBackgroundItemProviderInstanceId,
  cancelledItem,
  latestStartedRun,
} from "./RuntimeRecoveryPolicy.ts";
import { restartStatus } from "./RestartStatus.ts";
import { restartReapprovalEvents } from "./RestartHandoffImport.ts";
import {
  prepareRestart,
  abortRestart,
  importRestartHandoff,
  prepareForShutdown,
} from "./RestartPreparation.ts";
import { recoveryQueueHold } from "./QueueHoldPolicy.ts";
import { rearmCancelledBackgroundWork } from "./RestartBackgroundRearm.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  ServerPrepareRestartError,
  ServerImportRestartHandoffError,
  type ServerImportRestartHandoffInput,
  type ServerPrepareRestartResult,
  type ServerRestartStatus,
  type ServerRestartHandoff,
  isProviderNativeSubagentThread,
  type OrchestrationV2DomainEvent,
  type ProviderThreadId,
  type OrchestrationV2RestartCancelledBackgroundWork,
  type OrchestrationV2ThreadProjection,
  isOrchestrationV2WorkActive,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectOutboxModel from "./EffectOutboxModel.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { restartContinuationRun, unacceptedRestartRun } from "./RestartContinuation.ts";
import { isBufferedProviderNotification } from "./NotificationMailbox.ts";
import {
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  awaitingProviderThreadId,
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  mergeRestartCancelledBackgroundWork,
} from "./RestartBackgroundNote.ts";

export class ProviderRuntimeRecoveryError extends Schema.TaggedError<ProviderRuntimeRecoveryError>()(
  "ProviderRuntimeRecoveryError",
  {
    operation: Schema.Literals(["read-projections", "reconcile", "drain-outbox"]),
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider runtime recovery failed during ${this.operation}.`;
  }
}

export interface ProviderRuntimeRecoverySummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
}

export interface ProviderRuntimeReconciliationSummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
}

export class ProviderRuntimeRecoveryService extends Context.Service<
  ProviderRuntimeRecoveryService,
  {
    readonly getRestartStatus: (
      epoch: string,
    ) => Effect.Effect<ServerRestartStatus, ServerPrepareRestartError>;
    readonly abortRestart: (
      epoch: string,
    ) => Effect.Effect<{ epoch: string; aborted: true }, ServerPrepareRestartError>;
    readonly importRestartHandoff: (
      input: ServerImportRestartHandoffInput,
    ) => Effect.Effect<ServerPrepareRestartResult, ServerImportRestartHandoffError>;
    readonly prepareRestart: (
      epoch: string,
      drainTimeoutMs?: number,
    ) => Effect.Effect<ServerPrepareRestartResult, ServerPrepareRestartError>;
    readonly reconcile: (
      trigger: "startup" | "shutdown",
    ) => Effect.Effect<ProviderRuntimeReconciliationSummary, ProviderRuntimeRecoveryError>;
    readonly prepareForShutdown: Effect.Effect<void, ProviderRuntimeRecoveryError>;
    readonly recover: Effect.Effect<ProviderRuntimeRecoverySummary, ProviderRuntimeRecoveryError>;
  }
>()("t3/orchestration-v2/ProviderRuntimeRecoveryService") {}

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  type RecoverySession = ProjectionStore.ProjectionRuntimeRecoveryState["providerSessions"][number];
  /** Shared sessions stop on their first recovered thread; later threads still decide wakes from pre-recovery liveness. */
  const sessionsLiveAtStart = (
    projection: ProjectionStore.ProjectionRuntimeRecoveryState,
    stoppedThisPass: ReadonlyMap<string, RecoverySession>,
  ) => {
    const sessions = new Map(projection.providerSessions.map((session) => [session.id, session]));
    for (const providerThread of projection.providerThreads) {
      const stopped =
        providerThread.providerSessionId === null
          ? undefined
          : stoppedThisPass.get(providerThread.providerSessionId);
      if (stopped !== undefined) sessions.set(stopped.id, stopped);
    }
    return [...sessions.values()];
  };

  const reconcileProjection = Effect.fn("ProviderRuntimeRecoveryService.reconcileProjection")(
    function* (
      projection: ProjectionStore.ProjectionRuntimeRecoveryState,
      trigger: "startup" | "shutdown",
      continueAfterRestart: boolean,
      stoppedThisPass: ReadonlyMap<string, RecoverySession> = new Map(),
      handoff?: ServerRestartHandoff,
    ) {
      const now = yield* DateTime.now;
      const runs = [] as Array<OrchestrationV2ThreadProjection["runs"][number]>;
      for (const run of nonterminalRuns(projection)) {
        if (run.status === "waiting") {
          const checkpointEffects = yield* outbox
            .listByCommandId(CommandId.make(`command:effect:checkpoint.capture:${run.id}`))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderRuntimeRecoveryError({
                    operation: "reconcile",
                    threadId: projection.thread.id,
                    cause,
                  }),
              ),
            );
          const hasReplayableCheckpoint = checkpointEffects.some(
            (effect) =>
              effect.request.type === "checkpoint.capture" &&
              effect.request.runId === run.id &&
              (effect.status === "pending" || effect.status === "running"),
          );
          if (hasReplayableCheckpoint) continue;
        }
        runs.push(run);
      }
      const pendingRequests = projection.runtimeRequests.filter(
        (request) => request.status === "pending",
      );
      const questions = pendingRequests.filter(
        (request) =>
          request.kind === "user_input" &&
          request.responseCapability.type === "live" &&
          projection.turnItems.some(
            (item) =>
              item.type === "user_input_request" &&
              item.requestId === request.id &&
              item.nodeId === request.nodeId &&
              item.questions.length > 0 &&
              item.questions.every((question) => question.question.trim().length > 0),
          ) &&
          !isProviderNativeSubagentThread(projection.thread),
      );
      const recoveredRequestIds = new Set(questions.map((request) => request.id));
      const messageRequestNodeIds = new Set(
        pendingRequests
          .filter(
            (request) =>
              request.responseCapability.type === "message" || recoveredRequestIds.has(request.id),
          )
          .map((request) => request.nodeId),
      );
      const requests = pendingRequests.filter(
        (request) =>
          request.responseCapability.type !== "message" && !recoveredRequestIds.has(request.id),
      );
      const delegatedTaskNodeIds = new Set<string>([
        ...(projection.subagents ?? []).filter(isAppOwnedDelegation).map((subagent) => subagent.id),
        ...(projection.turnItems ?? []).flatMap((item) =>
          item.type === "subagent" && isAppOwnedDelegation(item) ? [item.subagentId] : [],
        ),
      ]);
      const detail = `Cancelled because the server ${trigger === "startup" ? "restarted" : "shut down"} before the provider work completed.`;
      const commandId = CommandId.make(
        `command:runtime-reconcile:${trigger}:${projection.thread.id}:${DateTime.formatIso(now)}`,
      );
      const allocateEventId = () =>
        ids.allocate.event({ threadId: projection.thread.id, commandId }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "reconcile",
                threadId: projection.thread.id,
                cause,
              }),
          ),
        );
      const events: Array<OrchestrationV2DomainEvent> = [];
      const cancelledBackgroundWork = new Map<
        ProviderThreadId,
        Array<OrchestrationV2RestartCancelledBackgroundWork>
      >();
      const cancelledBackgroundNativeIds = new Set<string>();
      const recordCancelledBackgroundWork = (
        providerThreadId: ProviderThreadId | null | undefined,
        work: OrchestrationV2RestartCancelledBackgroundWork,
      ) => {
        if (providerThreadId == null) return;
        const existing = cancelledBackgroundWork.get(providerThreadId);
        if (existing === undefined) cancelledBackgroundWork.set(providerThreadId, [work]);
        else existing.push(work);
      };
      const recordCancelledBackgroundItem = (
        item: OrchestrationV2ThreadProjection["turnItems"][number],
      ) => {
        if (!isBackgroundCapableTurnItemType(item.type)) return;
        const awaitingId = awaitingProviderThreadId(item, projection.runs);
        const ownProviderThread =
          item.providerThreadId === awaitingId
            ? undefined
            : (projection.providerThreads ?? []).find(
                (candidate) => candidate.id === item.providerThreadId,
              );
        const work = cancelledTurnItemWork(
          item,
          ownProviderThread?.nativeThreadRef?.nativeId ?? undefined,
        );
        if (work === undefined) return;
        recordCancelledBackgroundWork(awaitingId, work);
        if (item.nativeItemRef?.nativeId != null) {
          cancelledBackgroundNativeIds.add(item.nativeItemRef.nativeId);
        }
      };
      const queuedRuns = projection.runs.filter((run) => run.status === "queued");
      const queuedMessages =
        queuedRuns.length === 0
          ? []
          : (yield* projections
              .getThreadRecords(projection.thread.id, ["messages"], {
                messageIds: queuedRuns.map((run) => run.userMessageId),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderRuntimeRecoveryError({
                      operation: "read-projections",
                      threadId: projection.thread.id,
                      cause,
                    }),
                ),
              )).messages;
      const bufferedMessageIds = new Set(
        queuedMessages.filter(isBufferedProviderNotification).map((message) => message.id),
      );
      for (const run of queuedRuns) {
        if (bufferedMessageIds.has(run.userMessageId)) {
          runs.push(run);
          continue;
        }
        const recovered = recoveryQueueHold(run, trigger);
        if (recovered === undefined) continue;
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: recovered,
        });
      }
      for (const question of questions) {
        events.push({
          id: yield* allocateEventId(),
          type: "runtime-request.updated",
          threadId: projection.thread.id,
          nodeId: question.nodeId,
          occurredAt: now,
          payload: { ...question, responseCapability: { type: "message" } },
        });
      }
      for (const request of requests) {
        events.push({
          id: yield* allocateEventId(),
          type: "runtime-request.updated",
          threadId: projection.thread.id,
          nodeId: request.nodeId,
          occurredAt: now,
          payload: {
            ...request,
            status: trigger === "startup" ? "expired" : "cancelled",
            responseCapability: {
              type: "not_resumable",
              reason: `The server ${trigger === "startup" ? "restarted" : "shut down"} before this runtime request was resolved.`,
            },
            resolvedAt: now,
          },
        });
      }
      for (const run of runs) {
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "cancelled", queuePosition: null, completedAt: now },
        });
        for (const attempt of projection.attempts.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "run-attempt.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: attempt.rootNodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...attempt, status: "cancelled", completedAt: now },
          });
        }
        for (const node of projection.nodes.filter(
          (candidate) =>
            candidate.runId === run.id &&
            !messageRequestNodeIds.has(candidate.id) &&
            !delegatedTaskNodeIds.has(candidate.id) &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "node.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: node.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...node, status: "cancelled", completedAt: now },
          });
        }
        for (const providerTurn of projection.providerTurns.filter(
          (candidate) =>
            candidate.runAttemptId !== null &&
            projection.attempts.some(
              (attempt) => attempt.id === candidate.runAttemptId && attempt.runId === run.id,
            ) &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "provider-turn.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: providerTurn.nodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...providerTurn, status: "cancelled", completedAt: now },
          });
        }
        for (const message of projection.messages.filter(
          (candidate) => candidate.runId === run.id && candidate.streaming,
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "message.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(message.nodeId === null ? {} : { nodeId: message.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...message, streaming: false, updatedAt: now },
          });
        }
        for (const item of projection.turnItems.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.nodeId === null || !messageRequestNodeIds.has(candidate.nodeId)) &&
            !isAppOwnedDelegationItem(candidate) &&
            // A link card waits on the user, not the run, and answers by message.
            candidate.type !== "link_request" &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          if (run.status === "waiting") recordCancelledBackgroundItem(item);
          else if (item.type === "subagent" && item.origin === "provider_native")
            recordCancelledBackgroundItem(item);
          events.push({
            id: yield* allocateEventId(),
            type: "turn-item.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: cancelledItem(item, now),
          });
        }
      }
      const cutRunIds = new Set(runs.map((run) => run.id));
      for (const task of projection.subagents ?? []) {
        if (
          task.origin !== "app_owned" ||
          task.runId === null ||
          !cutRunIds.has(task.runId) ||
          task.completionWake !== "settled_only" ||
          !isOrchestrationV2WorkActive(task.status)
        )
          continue;
        events.push({
          id: yield* allocateEventId(),
          type: "subagent.updated",
          threadId: projection.thread.id,
          runId: task.runId,
          nodeId: task.id,
          driver: task.driver,
          providerInstanceId: task.providerInstanceId,
          occurredAt: now,
          payload: { ...task, completionWake: "always", updatedAt: now },
        });
      }
      const recoveredNonterminalRunIds = new Set(runs.map((run) => run.id));
      const cancelledStaleNodeIds = new Set<string>();
      for (const item of projection.turnItems ?? []) {
        if (item.runId !== null && recoveredNonterminalRunIds.has(item.runId)) {
          continue;
        }
        if (!isBackgroundCapableTurnItemType(item.type)) {
          continue;
        }
        if (!isNonterminalTurnItemStatus(item.status) || isAppOwnedDelegationItem(item)) {
          continue;
        }
        const providerInstanceId = resolveStaleBackgroundItemProviderInstanceId(item, projection);
        recordCancelledBackgroundItem(item);
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          ...(item.runId === null ? {} : { runId: item.runId }),
          ...(item.nodeId === null || item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
          providerInstanceId,
          occurredAt: now,
          payload: cancelledItem(item, now),
        });
        if (item.nodeId !== null && item.nodeId !== undefined) {
          const staleItemNode = projection.nodes.find(
            (candidate) =>
              candidate.id === item.nodeId && isNonterminalTurnItemStatus(candidate.status),
          );
          if (staleItemNode !== undefined && !cancelledStaleNodeIds.has(staleItemNode.id)) {
            cancelledStaleNodeIds.add(staleItemNode.id);
            events.push({
              id: yield* allocateEventId(),
              type: "node.updated",
              threadId: projection.thread.id,
              ...(item.runId === null ? {} : { runId: item.runId }),
              nodeId: staleItemNode.id,
              providerInstanceId,
              occurredAt: now,
              payload: { ...staleItemNode, status: "cancelled", completedAt: now },
            });
          }
        }
      }
      for (const subagent of projection.subagents ?? []) {
        events.push(
          ...(yield* endOrphanedNativeSubagent({
            projection,
            subagentId: subagent.id,
            status: "cancelled",
            now,
            emitted: events,
            allocateEventId,
          })),
        );
      }
      // Native subagent threads have no runs to settle their runless root turns.
      events.push(
        ...(yield* endRunlessRootTurns({
          threadId: projection.thread.id,
          providerInstanceId: projection.thread.providerInstanceId,
          projection,
          status: "cancelled",
          now,
          emitted: events,
          allocateEventId,
        })),
      );
      for (const providerThread of projection.providerThreads ?? []) {
        const needsIdle = providerThread.status === "active";
        const needsRosterClear = providerThreadHasPendingBackgroundTasks(providerThread);
        if (!needsIdle && !needsRosterClear) {
          continue;
        }
        if (providerThread.ownerNodeId === null) {
          for (const task of providerThread.pendingBackgroundTasks ?? []) {
            // A subagent already recorded covers the shells it started.
            if (
              cancelledBackgroundNativeIds.has(task.taskId) ||
              (task.parentTaskId !== undefined &&
                cancelledBackgroundNativeIds.has(task.parentTaskId))
            )
              continue;
            cancelledBackgroundNativeIds.add(task.taskId);
            recordCancelledBackgroundWork(providerThread.id, cancelledRosterTaskWork(task));
          }
        }
        events.push({
          id: yield* allocateEventId(),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          occurredAt: now,
          payload: {
            ...providerThread,
            status: needsIdle ? "idle" : providerThread.status,
            pendingBackgroundTasks: [],
            updatedAt: now,
          },
        });
      }
      for (const session of projection.providerSessions.filter(
        (candidate) => candidate.status !== "stopped" && candidate.status !== "error",
      )) {
        events.push({
          id: yield* allocateEventId(),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: session.providerInstanceId,
          occurredAt: now,
          payload: { ...session, status: "stopped", updatedAt: now, lastError: null },
        });
      }
      for (const [providerThreadId, work] of cancelledBackgroundWork) {
        const noteRun = latestStartedRun(projection, providerThreadId);
        if (noteRun === undefined) continue;
        // Use a separate event; stale run snapshots can overwrite intervening lifecycle changes.
        events.push({
          id: yield* allocateEventId(),
          type: "run.background-work-cancelled",
          threadId: projection.thread.id,
          runId: noteRun.id,
          providerInstanceId: noteRun.providerInstanceId,
          occurredAt: now,
          payload: {
            runId: noteRun.id,
            restartCancelledBackgroundWork: yield* rearmCancelledBackgroundWork(
              mergeRestartCancelledBackgroundWork(
                noteRun.restartCancelledBackgroundWork ?? [],
                work,
              ),
              projection,
              providerThreadId,
              projections,
            ),
          },
        });
      }
      const continuationRun =
        handoff === undefined && continueAfterRestart && trigger === "startup"
          ? (restartContinuationRun({
              ...projection,
              providerSessions: sessionsLiveAtStart(projection, stoppedThisPass),
            }) ?? unacceptedRestartRun(projection))
          : undefined;
      const effects: Array<EffectOutboxModel.PendingOrchestrationEffectV2> = continuationRun
        ? [
            {
              id: `effect:restart-continuation:${continuationRun.id}`,
              commandId,
              threadId: projection.thread.id,
              request: { type: "provider-runtime.continue", sourceRunId: continuationRun.id },
            },
          ]
        : [];
      const stoppedSessions = projection.providerSessions.filter(
        (candidate) => candidate.status !== "stopped" && candidate.status !== "error",
      ).length;
      let retiredEffects: number;
      if (events.length === 0) {
        const retiredEffectIds = yield* outbox
          .cancelUnsettled({
            threadId: projection.thread.id,
            effectTypes: EffectOutboxModel.PROCESS_BOUND_EFFECT_TYPES,
            reason: detail,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause: { detail, cause },
                }),
            ),
          );
        yield* outbox.signalCancellations(retiredEffectIds);
        retiredEffects = retiredEffectIds.length;
      } else {
        const result = yield* eventSink
          .commitCommand({
            commandId,
            threadId: projection.thread.id,
            commandType: "provider-runtime.reconcile",
            acceptedAt: now,
            events,
            effects,
            cancelUnsettledEffects: {
              effectTypes: EffectOutboxModel.PROCESS_BOUND_EFFECT_TYPES,
              reason: detail,
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause,
                }),
            ),
          );
        retiredEffects = result.cancelledEffectCount;
      }
      return {
        terminalizedRuns: runs.length,
        stoppedSessions,
        closedRequests: requests.length,
        retiredEffects,
      };
    },
  );

  const reconcile = Effect.fn("ProviderRuntimeRecoveryService.reconcile")(function* (
    trigger: "startup" | "shutdown",
  ) {
    const handoffs = yield* outbox.restartHandoffs.pipe(
      Effect.mapError(
        (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
      ),
    );
    const continueAfterRestart = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const threadIds = yield* projections
      .getRecoveryThreadIds("runtime")
      .pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
        ),
      );
    let terminalizedRuns = 0;
    let stoppedSessions = 0;
    let closedRequests = 0;
    let retiredEffects = 0;
    const stoppedThisPass = new Map<string, RecoverySession>();
    for (const threadId of threadIds) {
      const projection = yield* projections.getRuntimeRecoveryProjection(threadId).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderRuntimeRecoveryError({
              operation: "read-projections",
              threadId,
              cause,
            }),
        ),
      );
      const enabled =
        continueAfterRestart !== null &&
        resolveProjectSettings(continueAfterRestart, projection.thread.projectId).settings
          .continueThreadsAfterServerUpdate;
      const handoff = handoffs.find((effect) => effect.threadId === threadId)?.request;
      if (
        trigger === "startup" &&
        handoff?.type === "provider-runtime.restart-handoff" &&
        projection.thread.archivedAt === null &&
        projection.thread.deletedAt === null &&
        projection.thread.settledOverride !== "settled"
      ) {
        const full = yield* projections.getThreadProjection(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "read-projections",
                threadId,
                cause,
              }),
          ),
        );
        const reapproval = yield* restartReapprovalEvents(
          full,
          handoff.epoch,
          handoff.handoff.runIds,
          [
            ...new Set([
              ...handoff.handoff.requestIds,
              ...full.runtimeRequests
                .filter((request) => request.status === "pending")
                .map((request) => request.id),
            ]),
          ],
        ).pipe(
          Effect.provideService(IdAllocator.IdAllocatorV2, ids),
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({ operation: "reconcile", threadId, cause }),
          ),
        );
        if (reapproval.events.length > 0)
          yield* eventSink
            .write({ events: reapproval.events })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderRuntimeRecoveryError({ operation: "reconcile", threadId, cause }),
              ),
            );
      }
      const result = yield* reconcileProjection(
        projection,
        trigger,
        enabled,
        stoppedThisPass,
        handoff?.type === "provider-runtime.restart-handoff" ? handoff.handoff : undefined,
      );
      for (const session of projection.providerSessions) {
        if (session.status !== "stopped" && session.status !== "error") {
          stoppedThisPass.set(session.id, session);
        }
      }
      terminalizedRuns += result.terminalizedRuns;
      stoppedSessions += result.stoppedSessions;
      closedRequests += result.closedRequests;
      retiredEffects += result.retiredEffects;
    }
    const outboxReconciliation = yield* outbox.reconcileAfterProcessLoss.pipe(
      Effect.mapError(
        (cause) => new ProviderRuntimeRecoveryError({ operation: "drain-outbox", cause }),
      ),
    );
    return {
      terminalizedRuns,
      stoppedSessions,
      closedRequests,
      retiredEffects: retiredEffects + outboxReconciliation.cancelled,
      requeuedEffects: outboxReconciliation.requeued,
    } satisfies ProviderRuntimeReconciliationSummary;
  });

  const recover = reconcile("startup");

  const restartContext = yield* Effect.context<
    | EffectOutbox.EffectOutboxV2
    | ProjectionStore.ProjectionStoreV2
    | EventSink.EventSinkV2
    | IdAllocator.IdAllocatorV2
    | ServerSettings.ServerSettingsService
  >();
  return ProviderRuntimeRecoveryService.of({
    getRestartStatus: Effect.fn("ProviderRuntimeRecoveryService.getRestartStatus")((epoch) =>
      restartStatus(epoch).pipe(Effect.provide(restartContext)),
    ),
    abortRestart: Effect.fn("ProviderRuntimeRecoveryService.abortRestart")((epoch) =>
      abortRestart(epoch).pipe(Effect.provide(restartContext)),
    ),
    importRestartHandoff: Effect.fn("ProviderRuntimeRecoveryService.importRestartHandoff")(
      (input) => importRestartHandoff(input).pipe(Effect.provide(restartContext)),
    ),
    prepareRestart: Effect.fn("ProviderRuntimeRecoveryService.prepareRestart")(
      (epoch, drainTimeoutMs) =>
        prepareRestart(epoch, drainTimeoutMs).pipe(Effect.provide(restartContext)),
    ),
    reconcile,
    prepareForShutdown: prepareForShutdown.pipe(
      Effect.provide(restartContext),
      Effect.mapError(
        (cause) => new ProviderRuntimeRecoveryError({ operation: "reconcile", cause }),
      ),
    ),
    recover,
  });
});

export const layer = Layer.effect(ProviderRuntimeRecoveryService, make);
