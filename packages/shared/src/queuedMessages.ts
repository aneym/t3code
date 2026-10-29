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
  releaseHeld = false,
): OrchestrationV2ConversationMessage | undefined {
  if (
    run.status !== "queued" ||
    (!releaseHeld && run.queueHeld === true) ||
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

export function sendAllQueuedMembers(projection: QueueProjection) {
  const members: Array<{
    readonly run: OrchestrationV2Run;
    readonly message: OrchestrationV2ConversationMessage;
  }> = [];
  const ordered = projection.runs
    .filter((run) => run.status === "queued")
    .sort(
      (left, right) =>
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal,
    );
  for (const run of ordered) {
    const message = batchableQueuedMessage(projection, run, true);
    if (message === undefined || message.delegatedCompletion !== undefined) continue;
    const first = members[0]?.run;
    if (first !== undefined && !compatibleQueuedRuns(first, run)) continue;
    members.push({ run, message });
    if (members.length === MAX_QUEUED_MESSAGE_BATCH_SIZE) break;
  }
  return members;
}
