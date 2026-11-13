import type {
  ProviderRuntimeRecoverySummary,
  ProviderRuntimeReconciliationSummary,
} from "./ProviderRuntimeRecoverySummary.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { restartRunUpdates, cancelledRuntimeDetail } from "./RestartRunRecovery.ts";
import type { RecoverySession } from "./RuntimeRecoverySessions.ts";
import { makeRestartReapproval, survivesRestart } from "./RestartHandoffImport.ts";
import { makeHandoffDrain } from "./RestartDrain.ts";
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
import {
  prepareRestart,
  abortRestart,
  importRestartHandoff,
  prepareForShutdown,
} from "./RestartPreparation.ts";
import { recoveryQueueHold } from "./QueueHoldPolicy.ts";
import { rearmCancelledBackgroundWork } from "./RestartBackgroundRearm.ts";
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
import { isBufferedProviderNotification } from "./NotificationMailbox.ts";
import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";
import { restartRecoverySource } from "./RestartRecoverySource.ts";
import {
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  awaitingProviderThreadId,
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  mergeRestartCancelledBackgroundWork,
  neverStarted,
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

const isProviderRuntimeRecoveryError = Schema.is(ProviderRuntimeRecoveryError);

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
    readonly drainForHandoff: (
      epoch: string,
      timeoutMs: number,
    ) => Effect.Effect<void, ServerPrepareRestartError>;
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
  const reapproveHandoff = yield* makeRestartReapproval;

  const reconcileProjection = Effect.fn("ProviderRuntimeRecoveryService.reconcileProjection")(
    function* (
      projection: ProjectionStore.ProjectionRuntimeRecoveryState,
      trigger: "startup" | "shutdown",
      continueAfterRestart: boolean,
      stoppedThisPass: ReadonlyMap<string, RecoverySession> = new Map(),
      handoff?: ServerRestartHandoff,
    ) {
      const now = yield* DateTime.now;
      let runs = [] as Array<OrchestrationV2ThreadProjection["runs"][number]>;
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
      const detail = cancelledRuntimeDetail(trigger);
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
      const unstartedRuns = runs.filter(
        (run) =>
          run.status === "starting" &&
          neverStarted(run) &&
          !projection.providerTurns.some((turn) => turn.runAttemptId === run.activeAttemptId) &&
          !projection.runtimeRequests.some(
            (request) =>
              request.status === "pending" &&
              projection.nodes.some((node) => node.id === request.nodeId && node.runId === run.id),
          ),
      );
      const queuedRuns = projection.runs.filter((run) => run.status === "queued");
      const pendingRuns = [...unstartedRuns, ...queuedRuns];
      const queuedMessages =
        pendingRuns.length === 0
          ? []
          : [
              ...(yield* projections
                .getMessagesById(
                  projection.thread.id,
                  pendingRuns.map((run) => run.userMessageId),
                )
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderRuntimeRecoveryError({
                        operation: "read-projections",
                        threadId: projection.thread.id,
                        cause,
                      }),
                  ),
                )).values(),
            ];
      const bufferedMessageIds = new Set(
        queuedMessages.filter(isBufferedProviderNotification).map((message) => message.id),
      );
      const retryableMessageIds = new Set(
        queuedMessages
          .filter(
            (message) =>
              message.createdBy === "user" &&
              message.scheduledTaskId === undefined &&
              message.notification === undefined &&
              message.delegatedCompletion === undefined,
          )
          .map((message) => message.id),
      );
      // A saved user message the provider never accepted stays available through the held queue.
      const retryableRuns = unstartedRuns.filter((run) =>
        retryableMessageIds.has(run.userMessageId),
      );
      const retryableRunIds = new Set(retryableRuns.map((run) => run.id));
      const retryableItems =
        retryableRuns.length === 0
          ? []
          : (yield* projections
              .getThreadRecords(projection.thread.id, ["turnItems"], {
                turnItemTypes: ["user_message"],
                turnItemRunIds: retryableRuns.map((run) => run.id),
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
              )).turnItems;
      for (const item of retryableItems) {
        if (item.type !== "user_message" || !retryableMessageIds.has(item.messageId)) continue;
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          ...(item.runId === null ? {} : { runId: item.runId }),
          occurredAt: now,
          payload: {
            ...item,
            inputIntent: "queued_turn",
            status: "pending",
            startedAt: null,
            completedAt: null,
            updatedAt: now,
          },
        });
      }
      runs = runs.filter((run) => !retryableRunIds.has(run.id));
      const heldRuns = [
        ...retryableRuns,
        ...queuedRunsInDeliveryOrder({ runs: queuedRuns, messages: queuedMessages }),
      ];
      for (const [index, run] of heldRuns.entries()) {
        if (bufferedMessageIds.has(run.userMessageId)) {
          runs.push(run);
          continue;
        }
        const recovered =
          retryableRuns.length === 0
            ? recoveryQueueHold(run, trigger)
            : {
                ...run,
                queueHeld: true,
                ...(run.queueHeld === true ? {} : { queueHoldReason: "restart" as const }),
              };
        if (recovered === undefined) continue;
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            ...recovered,
            status: "queued",
            ...(retryableRuns.length === 0 ? {} : { queuePosition: index + 1 }),
          },
        });
      }
      const unsentResumeRunIds = runs.flatMap((run) =>
        run.startedAt === null && run.usageLimitContinuationOfRunId !== undefined ? [run.id] : [],
      );
      const limitRecovery = projection.thread.limitRecovery;
      // The unsent resume spent the worker's request id, so a fresh one lets it send again. An
      // untagged resume from an older server stays cancelled: its copy couldn't be hidden.
      if (limitRecovery?.autoResume === true && unsentResumeRunIds.length > 0) {
        events.push({
          id: yield* allocateEventId(),
          type: "thread.metadata-updated",
          threadId: projection.thread.id,
          occurredAt: now,
          payload: {
            ...projection.thread,
            limitRecovery: { ...limitRecovery, requestId: commandId },
            updatedAt: now,
          },
        });
      }
      // The worker sends the auto-resume again, so the unsent copy leaves the transcript the way
      // cancelled queued input does.
      const unsentResumePrompts =
        unsentResumeRunIds.length === 0
          ? []
          : (yield* projections
              .getThreadRecords(projection.thread.id, ["turnItems"], {
                turnItemTypes: ["user_message"],
                turnItemRunIds: unsentResumeRunIds,
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
              )).turnItems;
      const unsentResumePromptIds = new Set(unsentResumePrompts.map((item) => item.id));
      for (const item of unsentResumePrompts) {
        if (item.type !== "user_message") continue;
        const active =
          item.status === "pending" || item.status === "running" || item.status === "waiting";
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          ...(item.runId === null ? {} : { runId: item.runId }),
          occurredAt: now,
          payload: {
            ...item,
            ...(active ? { status: "cancelled", completedAt: now } : {}),
            inputIntent: "queued_turn",
            updatedAt: now,
          },
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
      const continuationSource = restartRecoverySource(
        projection,
        trigger,
        stoppedThisPass,
        now,
        handoff,
      );
      events.push(
        ...(yield* restartRunUpdates({
          threadId: projection.thread.id,
          runs,
          allRuns: projection.runs,
          source: continuationSource,
          continueAfterRestart,
          now,
          handoff,
          allocateEventId,
        })),
      );
      for (const run of runs) {
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
            !unsentResumePromptIds.has(candidate.id) &&
            (candidate.nodeId === null || !messageRequestNodeIds.has(candidate.nodeId)) &&
            !isAppOwnedDelegationItem(candidate) &&
            !survivesRestart(candidate, handoff) &&
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
        // Queued runs and unsent resumes leave no visible turn behind, so there is nothing to explain.
        if (run.status === "queued" || unsentResumeRunIds.includes(run.id)) continue;
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            id: ids.derive.runSignalTurnItem({ runId: run.id, signal: "server-recovery" }),
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: run.rootNodeId,
            providerThreadId: run.providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            // EventSink allocates the real position, after the run's existing items.
            ordinal: 0,
            status: "completed",
            title: trigger === "startup" ? "Server restarted" : "Server shut down",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "system_notice",
            message: detail,
          },
        });
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
      const staleNodeIds = new Set<string>();
      for (const item of projection.turnItems ?? []) {
        if (item.runId !== null && cutRunIds.has(item.runId)) {
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
          if (staleItemNode !== undefined && !staleNodeIds.has(staleItemNode.id)) {
            staleNodeIds.add(staleItemNode.id);
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
        (candidate) =>
          (candidate.status !== "stopped" && candidate.status !== "error") ||
          (candidate.status === "error" && (candidate.extensionStatuses?.length ?? 0) > 0),
      )) {
        events.push({
          id: yield* allocateEventId(),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: session.providerInstanceId,
          occurredAt: now,
          payload: {
            ...session,
            status: session.status === "error" ? "error" : "stopped",
            ...(session.extensionStatuses === undefined ? {} : { extensionStatuses: [] }),
            updatedAt: now,
            lastError: session.status === "error" ? session.lastError : null,
          },
        });
      }
      for (const [providerThreadId, work] of cancelledBackgroundWork) {
        const noteRun = latestStartedRun(projection, providerThreadId);
        if (noteRun === undefined) continue;
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
      const continuationRun = continueAfterRestart ? continuationSource : undefined;
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
      let cancelledEffectIds: ReadonlyArray<string> = [];
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
        cancelledEffectIds = retiredEffectIds;
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
        cancelledEffectIds,
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
    const read = Effect.fn("ProviderRuntimeRecoveryService.readRecoveryProjection")(
      (threadId: ThreadId) =>
        projections.getRuntimeRecoveryProjection(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "read-projections",
                threadId,
                cause,
              }),
          ),
        ),
    );
    const grouped = trigger === "shutdown" && threadIds.length > 1;
    const groupSize = grouped ? 32 : 1;
    const prefetched = grouped
      ? undefined
      : new Map(
          (yield* Effect.forEach(threadIds, read, { concurrency: 4 })).map((projection) => [
            projection.thread.id,
            projection,
          ]),
        );
    for (let offset = 0; offset < threadIds.length; offset += groupSize) {
      const cancelledEffectIds: string[] = [];
      const reconcileGroup = Effect.gen(function* () {
        for (const threadId of threadIds.slice(offset, offset + groupSize)) {
          const initial = prefetched?.get(threadId);
          const projection =
            initial === undefined ||
            initial.providerThreads.some(
              (thread) =>
                thread.providerSessionId !== null && stoppedThisPass.has(thread.providerSessionId),
            ) ||
            initial.providerSessions.some((session) => stoppedThisPass.has(session.id))
              ? yield* read(threadId)
              : initial;
          const enabled =
            continueAfterRestart === null ||
            resolveProjectSettings(continueAfterRestart, projection.thread.projectId).settings
              .continueThreadsAfterServerUpdate;
          const handoff = handoffs.find((effect) => effect.threadId === threadId)?.request;
          const reapprove = (secretsOnly: boolean) =>
            (trigger === "startup" &&
            handoff?.type === "provider-runtime.restart-handoff" &&
            handoff.handoff.runIds.length > 0 &&
            projection.thread.archivedAt === null &&
            projection.thread.deletedAt === null &&
            projection.thread.settledOverride !== "settled"
              ? reapproveHandoff(threadId, handoff, secretsOnly)
              : Effect.void
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderRuntimeRecoveryError({ operation: "reconcile", threadId, cause }),
              ),
            );
          yield* reapprove(false);
          const result = yield* reconcileProjection(
            projection,
            trigger,
            enabled,
            stoppedThisPass,
            handoff?.type === "provider-runtime.restart-handoff" ? handoff.handoff : undefined,
          );
          if (
            projection.turnItems?.some(
              (item) => item.type === "secret_request" && item.secretStatus === "pending",
            )
          )
            yield* reapprove(true);
          for (const session of projection.providerSessions) {
            if (session.status !== "stopped" && session.status !== "error") {
              stoppedThisPass.set(session.id, session);
            }
          }
          cancelledEffectIds.push(...result.cancelledEffectIds);
          terminalizedRuns += result.terminalizedRuns;
          stoppedSessions += result.stoppedSessions;
          closedRequests += result.closedRequests;
          retiredEffects += result.retiredEffects;
        }
      });
      yield* (grouped ? eventSink.withProviderBatch(reconcileGroup) : reconcileGroup).pipe(
        Effect.mapError((cause) =>
          isProviderRuntimeRecoveryError(cause)
            ? cause
            : new ProviderRuntimeRecoveryError({ operation: "reconcile", cause }),
        ),
      );
      if (cancelledEffectIds.length > 0) yield* outbox.signalCancellations(cancelledEffectIds);
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
  const handoff = yield* makeHandoffDrain;
  return ProviderRuntimeRecoveryService.of({
    drainForHandoff: Effect.fn("ProviderRuntimeRecoveryService.drainForHandoff")(
      (epoch, timeoutMs) => handoff.drain(epoch, timeoutMs).pipe(Effect.provide(restartContext)),
    ),
    getRestartStatus: Effect.fn("ProviderRuntimeRecoveryService.getRestartStatus")((epoch) =>
      restartStatus(epoch).pipe(Effect.provide(restartContext)),
    ),
    abortRestart: Effect.fn("ProviderRuntimeRecoveryService.abortRestart")((epoch) =>
      handoff
        .release(epoch)
        .pipe(Effect.andThen(abortRestart(epoch)), Effect.provide(restartContext)),
    ),
    importRestartHandoff: Effect.fn("ProviderRuntimeRecoveryService.importRestartHandoff")(
      (input) => importRestartHandoff(input).pipe(Effect.provide(restartContext)),
    ),
    prepareRestart: Effect.fn("ProviderRuntimeRecoveryService.prepareRestart")(
      (epoch, drainTimeoutMs) =>
        prepareRestart(epoch, drainTimeoutMs).pipe(
          Effect.tap(() => handoff.release(epoch)),
          Effect.provide(restartContext),
        ),
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
