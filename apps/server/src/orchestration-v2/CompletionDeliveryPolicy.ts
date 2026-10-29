import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2DelegatedCompletionDelivery,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

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

export function completionDeliveryOutcome(status: OrchestrationV2Run["status"], accepted: boolean) {
  return accepted || status === "completed"
    ? "delivered"
    : status === "cancelled"
      ? "retry"
      : "retryLater";
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
