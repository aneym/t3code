import {
  parseGoalCommand,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "./model.ts";

type QueueProjection = {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
};

export const MAX_QUEUED_MESSAGE_BATCH_SIZE = 20;

export function batchableQueuedMessage(
  projection: Pick<QueueProjection, "messages">,
  run: OrchestrationV2Run,
): OrchestrationV2ConversationMessage | undefined {
  if (
    run.status !== "queued" ||
    run.queueHeld === true ||
    run.restartContinuationOfRunId !== undefined ||
    run.delegatedTaskId !== undefined ||
    run.sourcePlanRef !== undefined
  )
    return undefined;
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  if (
    message === undefined ||
    message.notification !== undefined ||
    message.workflowScript === true ||
    message.scheduledTaskId !== undefined ||
    message.idleCompaction !== undefined ||
    message.text.trimStart().startsWith("/") ||
    parseGoalCommand(message) !== null
  )
    return undefined;
  return message;
}

export function compatibleQueuedRuns(first: OrchestrationV2Run, next: OrchestrationV2Run): boolean {
  return (
    first.providerInstanceId === next.providerInstanceId &&
    modelSelectionsEqual(first.modelSelection, next.modelSelection) &&
    first.workspacePreparation?.type === next.workspacePreparation?.type
  );
}
