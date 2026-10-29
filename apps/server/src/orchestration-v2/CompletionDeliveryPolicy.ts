import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2DelegatedCompletionDelivery,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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

export function completionBlockedBy(
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
