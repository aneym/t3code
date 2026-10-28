import {
  CommandId,
  ServerImportRestartHandoffError,
  type ServerImportRestartHandoffInput,
  NodeId,
  RuntimeRequestId,
  type RunId,
  type OrchestrationV2ThreadProjection,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type ServerRestartHandoff,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export const restartReapprovalEvents = Effect.fn("RestartHandoffImport.restartReapprovalEvents")(
  function* (
    projection: OrchestrationV2ThreadProjection,
    epoch: string,
    sourceIds: ReadonlyArray<RunId>,
    legacyRequestIds?: ReadonlyArray<RuntimeRequestId>,
  ) {
    const ids = yield* IdAllocator.IdAllocatorV2;
    const now = yield* DateTime.now;
    const threadId = projection.thread.id;
    const events: OrchestrationV2DomainEvent[] = [];
    const requestIds: RuntimeRequestId[] = [];
    const pausedRunIds = new Set<RunId>();
    const reviewDetails: string[] = [];
    const existingReview = projection.runtimeRequests.find(
      (request) => request.id === `restart-reapproval:${epoch}:${threadId}`,
    );
    if (existingReview !== undefined) {
      return {
        events,
        requestIds: existingReview.status === "pending" ? [existingReview.id] : [],
        pausedRunIds:
          existingReview.status === "pending"
            ? (existingReview.restartContinuationRunIds ?? []).filter((runId) =>
                sourceIds.includes(runId),
              )
            : [],
      };
    }
    let needsReapproval = false;
    for (const request of projection.runtimeRequests) {
      if (request.status !== "pending" || request.responseCapability.type !== "message") continue;
      const runId = projection.nodes.find((node) => node.id === request.nodeId)?.runId;
      if (runId !== null && runId !== undefined && sourceIds.includes(runId)) {
        pausedRunIds.add(runId);
        requestIds.push(request.id);
        if (!request.restartContinuationRunIds?.includes(runId)) {
          events.push({
            id: yield* ids.allocate.event({ threadId }),
            type: "runtime-request.updated",
            threadId,
            nodeId: request.nodeId,
            occurredAt: now,
            payload: { ...request, restartContinuationRunIds: [runId] },
          });
        }
      }
    }
    const selectedRequests = projection.runtimeRequests.filter(
      (request) =>
        request.status !== "resolved" &&
        request.responseCapability.type !== "message" &&
        request.kind !== "dynamic_tool_call" &&
        request.kind !== "auth_refresh" &&
        (legacyRequestIds === undefined
          ? request.status === "pending"
          : legacyRequestIds.includes(request.id)),
    );
    for (const request of selectedRequests) {
      const node = projection.nodes.find((row) => row.id === request.nodeId);
      const turn = projection.providerTurns.find((row) => row.id === request.providerTurnId);
      const run = projection.runs.find(
        (row) =>
          row.id === node?.runId ||
          (row.activeAttemptId === turn?.runAttemptId && turn !== undefined),
      );
      if (run === undefined || !sourceIds.includes(run.id)) continue;
      pausedRunIds.add(run.id);
      needsReapproval = true;
      const original = projection.turnItems.find((item) => item.nodeId === request.nodeId);
      if (original?.type === "user_input_request") {
        reviewDetails.push(...original.questions.map((question) => question.question));
      } else {
        reviewDetails.push(original?.title ?? `Interrupted approval ${request.id}`);
      }
      if (request.status === "pending")
        events.push({
          id: yield* ids.allocate.event({ threadId }),
          type: "runtime-request.updated",
          threadId,
          nodeId: request.nodeId,
          occurredAt: now,
          payload: {
            ...request,
            status: "cancelled",
            responseCapability: {
              type: "not_resumable",
              reason:
                "The server restarted. Review the new interrupted-work question before continuing.",
            },
            resolvedAt: now,
          },
        });
    }
    for (const item of projection.turnItems) {
      if (
        item.type === "secret_request" &&
        item.runId !== null &&
        sourceIds.includes(item.runId) &&
        item.secretStatus !== "saved" &&
        item.secretStatus !== "declined"
      ) {
        pausedRunIds.add(item.runId);
        needsReapproval = true;
      }
    }
    if (!needsReapproval) return { events, requestIds, pausedRunIds: [...pausedRunIds] };
    const requestId = RuntimeRequestId.make(`restart-reapproval:${epoch}:${threadId}`);
    requestIds.push(requestId);
    if (!projection.runtimeRequests.some((request) => request.id === requestId)) {
      const nodeId = NodeId.make(`node:${requestId}`);
      const commandId = CommandId.make(`command:restart-import:${epoch}:${threadId}`);
      const emit = function* (event: Omit<OrchestrationV2DomainEvent, "id">) {
        events.push({
          ...event,
          id: yield* ids.allocate.event({ threadId, commandId }),
        } as OrchestrationV2DomainEvent);
      };
      yield* emit({
        type: "node.updated",
        threadId,
        nodeId,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      });
      yield* emit({
        type: "runtime-request.updated",
        threadId,
        nodeId,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          restartContinuationRunIds: [...pausedRunIds],
          createdAt: now,
          resolvedAt: null,
        },
      });
      yield* emit({
        type: "turn-item.updated",
        threadId,
        nodeId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`item:${requestId}`),
          threadId,
          runId: null,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: Math.max(0, ...projection.turnItems.map((item) => item.ordinal)) + 1,
          status: "waiting",
          title: "Review interrupted work",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "user_input_request",
          requestId,
          responseMode: "message",
          questions: [
            {
              id: "restart-review",
              header: "Restart review",
              options: [],
              required: true,
              allowCustomAnswer: true,
              question:
                "The server restarted while this work needed approval or secure input. The previous approval callback is no longer valid. Review the interrupted work and describe how to continue. Do not enter secrets here; request a new secure input prompt. No previous tool approval has been granted." +
                (reviewDetails.length === 0
                  ? ""
                  : `\n\nOriginal request:\n${reviewDetails.join("\n")}`),
            },
          ],
        },
      });
    }
    return { events, requestIds, pausedRunIds: [...pausedRunIds] };
  },
);

export const legacyRestartHandoffs = Effect.fn("RestartHandoffImport.legacyRestartHandoffs")(
  function* (input: ServerImportRestartHandoffInput) {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const store = yield* EventSink.EventSinkV2;
    const throughSequence = yield* store.latestSequence();
    if (input.capturedSequence > throughSequence) {
      return yield* new ServerImportRestartHandoffError();
    }
    const startedAt = DateTime.makeUnsafe(input.startedAt);
    const observed = yield* store
      .read({
        afterSequence: input.capturedSequence,
        throughSequence,
      })
      .pipe(Stream.runCollect);
    const captured = new Map(input.threads.map((thread) => [thread.threadId, thread]));
    const discovered = new Map<ThreadId, Set<RunId>>();
    for (const row of observed) {
      const event = row.event;
      if (DateTime.isLessThan(event.occurredAt, startedAt)) continue;
      if (event.type !== "run.created" && event.type !== "run.updated") continue;
      const run = event.payload;
      const shutdown =
        run.status === "cancelled" && row.commandId?.startsWith("command:runtime-reconcile:");
      if (!shutdown && run.status !== "queued") continue;
      const sources = discovered.get(event.threadId) ?? new Set<RunId>();
      if (shutdown) sources.add(run.id);
      discovered.set(event.threadId, sources);
    }
    const threadIds = new Set([...captured.keys(), ...discovered.keys()]);
    const handoffs: ServerRestartHandoff[] = [];
    const events: OrchestrationV2DomainEvent[] = [];
    for (const threadId of threadIds) {
      const projection = yield* projections.getThreadProjection(threadId);
      const old = captured.get(threadId);
      const sourceIds = new Set([...(old?.runIds ?? []), ...(discovered.get(threadId) ?? [])]);
      const currentRequests = projection.runtimeRequests.filter(
        (request) =>
          old?.requestIds.includes(request.id) ||
          observed.some(
            (row) =>
              row.event.threadId === threadId &&
              row.event.type === "runtime-request.updated" &&
              row.event.payload.id === request.id &&
              row.commandId?.startsWith("command:runtime-reconcile:") &&
              !DateTime.isLessThan(row.event.occurredAt, startedAt),
          ),
      );
      const excluded =
        projection.thread.archivedAt !== null ||
        projection.thread.deletedAt !== null ||
        projection.thread.settledOverride === "settled";
      const runIds = projection.runs
        .filter(
          (run) =>
            sourceIds.has(run.id) &&
            !projection.runs.some((candidate) => candidate.restartContinuationOfRunId === run.id) &&
            ((run.status === "cancelled" && discovered.get(threadId)?.has(run.id)) ||
              ["preparing", "starting", "running", "waiting"].includes(run.status)) &&
            !projection.turnItems.some(
              (item) => item.type === "run_interrupt_request" && item.runId === run.id,
            ),
        )
        .map((run) => run.id);
      const requestIds = currentRequests
        .filter(
          (request) =>
            request.status === "pending" && request.responseCapability.type === "message",
        )
        .map((request) => request.id);
      const reapproval = excluded
        ? { events: [], requestIds: [], pausedRunIds: [] }
        : yield* restartReapprovalEvents(
            projection,
            input.epoch,
            runIds,
            currentRequests.map((request) => request.id),
          );
      events.push(...reapproval.events);
      requestIds.push(...reapproval.requestIds);
      handoffs.push({
        threadId,
        runIds,
        sourceRunIds: [...sourceIds],
        queuedRunIds: projection.runs.filter((run) => run.status === "queued").map((run) => run.id),
        requestIds,
        delegatedTaskIds: projection.subagents
          .filter((task) => ["pending", "running", "waiting"].includes(task.status))
          .map((task) => task.id),
        paused: excluded,
        pausedRunIds: reapproval.pausedRunIds,
      });
    }
    return { handoffs, events };
  },
  Effect.mapError((cause) => new ServerImportRestartHandoffError({ cause })),
);
