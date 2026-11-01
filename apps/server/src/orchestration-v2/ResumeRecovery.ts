import type * as EventSink from "./EventSink.ts";
import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ContextHandoffService from "./ContextHandoffService.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";

export const prepareResumeRecovery = Effect.fn("ProviderTurnStartService.prepareRecoveryHandoff")(
  function* (input: {
    readonly contextHandoffService: ContextHandoffService.ContextHandoffServiceV2["Service"];
    readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
    readonly projectionStore: ProjectionStore.ProjectionStoreV2["Service"];
    readonly projection: {
      readonly thread: { readonly id: OrchestrationV2Run["threadId"] };
      readonly runs: ReadonlyArray<OrchestrationV2Run>;
    };
    readonly run: OrchestrationV2Run;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly items: (
      items: ReadonlyArray<OrchestrationV2TurnItem>,
    ) => ReadonlyArray<OrchestrationV2TurnItem>;
  }) {
    const { projection, run, providerThread } = input;
    const transferId = yield* input.idAllocator.allocate.contextTransfer({
      sourceThreadId: projection.thread.id,
      targetThreadId: projection.thread.id,
      type: "provider_resume_fallback",
    });
    const createdAt = yield* DateTime.now;
    const handoff = yield* input.contextHandoffService.prepareProviderHandoff({
      threadId: projection.thread.id,
      targetRunId: run.id,
      transferId,
      fromProviderThreadIds: [providerThread.id],
      toProviderThreadId: providerThread.id,
      fromProviderInstanceId: providerThread.providerInstanceId,
      toProviderInstanceId: run.providerInstanceId,
      coveredRunOrdinals: { from: 1, to: Math.max(1, run.ordinal - 1) },
      strategy: "full_thread_summary",
      runs: projection.runs,
      items: input.items(yield* input.projectionStore.getTurnStartHistory(projection.thread.id)),
      createdAt,
    });
    return { handoff, transferId, createdAt };
  },
);

export const writeResumeRecoveryNotice = Effect.fn("ProviderTurnStartService.resumeRecoveryNotice")(
  function* (input: {
    readonly eventSink: EventSink.EventSinkV2["Service"];
    readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
    readonly run: OrchestrationV2Run;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly createdAt: DateTime.Utc;
  }) {
    const { run, providerThread, createdAt } = input;
    yield* input.eventSink.write({
      events: [
        {
          id: yield* input.idAllocator.allocate.event({ threadId: run.threadId }),
          type: "turn-item.updated",
          threadId: run.threadId,
          runId: run.id,
          occurredAt: createdAt,
          payload: {
            id: input.idAllocator.derive.runSignalTurnItem({
              runId: run.id,
              signal: "resume-recovery",
            }),
            threadId: run.threadId,
            runId: run.id,
            nodeId: run.rootNodeId,
            providerThreadId: providerThread.id,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            type: "system_notice",
            title: "Session restarted fresh",
            message:
              "The provider session was restarted fresh with this thread's history because its previous session could not be resumed.",
            startedAt: createdAt,
            completedAt: createdAt,
            updatedAt: createdAt,
          },
        },
      ],
    });
  },
);
