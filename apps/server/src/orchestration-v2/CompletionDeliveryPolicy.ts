import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2DelegatedCompletionDelivery,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { isUndeliveredMailboxSteer } from "./NotificationMailbox.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";

export const completionDeliveryRun = (
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs">,
  delivery: OrchestrationV2DelegatedCompletionDelivery | null | undefined,
) => {
  if (delivery == null) return undefined;
  const message = projection.messages.find((candidate) => candidate.id === delivery.messageId);
  return projection.runs.find((candidate) => candidate.id === message?.runId);
};

export const completionDeliveryMessage = (
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
  delivery: OrchestrationV2DelegatedCompletionDelivery | null | undefined,
) =>
  delivery === null || delivery === undefined
    ? undefined
    : projection.messages.find((candidate) => candidate.id === delivery.messageId);

function completionDeliveryOutcome(status: OrchestrationV2Run["status"], accepted: boolean) {
  return accepted || status === "completed"
    ? ("delivered" as const)
    : status === "cancelled"
      ? ("retry" as const)
      : ("retryLater" as const);
}

function completionBlockedBy(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
  ownership: OrchestrationV2ConversationMessage["delegatedCompletion"],
) {
  if (ownership === undefined) return undefined;
  const delivery = projection.runs.find((run) => run.id === ownership.parentRunId)
    ?.delegatedCompletion?.delivery;
  return delivery?.generation === ownership.generation
    ? projection.runs.find((run) => run.id === delivery?.blockedByRunId)
    : undefined;
}

export function completionQueueBlocked(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
  ownership: OrchestrationV2ConversationMessage["delegatedCompletion"],
): boolean {
  const blockedBy = completionBlockedBy(projection, ownership);
  return (
    blockedBy !== undefined &&
    !projection.runs.some((run) => run.status === "completed" && run.ordinal > blockedBy.ordinal)
  );
}

export const readCompletionDeliveries = Effect.fn("Orchestrator.readCompletionDeliveries")(
  function* (
    store: ProjectionStore.ProjectionStoreV2["Service"],
    threadId: ThreadId,
    run: Pick<OrchestrationV2Run, "id" | "status">,
  ) {
    const records = yield* store.getThreadRecords(threadId, ["messages"], {
      messageRunIds: [run.id],
      messageRoles: ["user"],
    });
    const messages = records.messages.filter(
      (message) => message.delegatedCompletion !== undefined,
    );
    let accepted = false;
    if (messages.length > 0) {
      const { runs, providerTurns } = yield* store.getThreadRecords(
        threadId,
        ["runs", "providerTurns"],
        {
          runIds: [run.id],
        },
      );
      const attemptId = runs[0]?.activeAttemptId;
      accepted = attemptId != null && providerTurns.some((turn) => turn.runAttemptId === attemptId);
    }
    return { messages, outcome: completionDeliveryOutcome(run.status, accepted) };
  },
);

export const readMissedCompletionDeliveries = Effect.fn(
  "Orchestrator.readMissedCompletionDeliveries",
)(function* (
  store: ProjectionStore.ProjectionStoreV2["Service"],
  threadId: ThreadId,
  view: Pick<OrchestrationV2ThreadProjection, "messages" | "runs">,
) {
  const missing = view.runs.flatMap((run) => {
    const delivery = run.delegatedCompletion?.delivery;
    return delivery != null && completionDeliveryMessage(view, delivery) === undefined
      ? [{ runId: run.id, messageId: delivery.messageId }]
      : [];
  });
  if (missing.length === 0) return [];
  const { messages } = yield* store.getThreadRecords(threadId, ["messages"], {
    messageRoles: ["user"],
    messageIds: missing.map((entry) => entry.messageId),
  });
  return missing
    .filter((entry) => !messages.some((message) => message.id === entry.messageId))
    .map((entry) => entry.runId);
});

export const readCompletionDeliveryOffer = Effect.fn("Orchestrator.readCompletionDeliveryOffer")(
  function* (
    store: ProjectionStore.ProjectionStoreV2["Service"],
    threadId: ThreadId,
    parentRunId: RunId,
  ) {
    const records = yield* store.getThreadRecords(threadId, ["runs", "providerThreads"], {
      runIds: [parentRunId],
    });
    const parentRun = records.runs.find((candidate) => candidate.id === parentRunId);
    const cohort = parentRun?.delegatedCompletion;
    const delivery = cohort?.delivery;
    if (
      parentRun === undefined ||
      cohort?.disposition !== "open" ||
      delivery == null ||
      delivery.taskIds.length === 0 ||
      records.thread.archivedAt !== null ||
      records.thread.deletedAt !== null
    ) {
      return undefined;
    }
    const { messages } = yield* store.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["user"],
      messageIds: [delivery.messageId],
    });
    if (messages.length > 0) {
      const steer = yield* store.getThreadRecords(threadId, ["runs", "providerTurns"]);
      if (!isUndeliveredMailboxSteer({ ...steer, messages }, delivery.messageId)) return undefined;
    }
    const providerThread =
      parentRun.providerThreadId === null
        ? undefined
        : records.providerThreads.find((candidate) => candidate.id === parentRun.providerThreadId);
    return providerThread === undefined ? undefined : { delivery, providerThread };
  },
);
