import {
  type NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  batchableQueuedMessage as batchableMessage,
  compatibleQueuedRuns,
  MAX_QUEUED_MESSAGE_BATCH_SIZE as MAX_BATCH_SIZE,
  sendAllQueuedMembers,
} from "@t3tools/shared/queuedMessages";

import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

export interface QueuedRunBatchMember {
  readonly run: OrchestrationV2Run;
  readonly message: OrchestrationV2ConversationMessage;
}

type UserTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }>;
type DraftEvent = OrchestrationV2DomainEvent extends infer Event
  ? Event extends OrchestrationV2DomainEvent
    ? Omit<Event, "id">
    : never
  : never;

function changesConversation(
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
  run: OrchestrationV2Run,
): boolean {
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  return (
    message !== undefined &&
    (message.idleCompaction !== undefined || message.text.trimStart().startsWith("/"))
  );
}

export function queuedRunBatch(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  first: OrchestrationV2Run,
  explicitRelease = false,
): ReadonlyArray<QueuedRunBatchMember> {
  if (explicitRelease)
    return sendAllQueuedMembers(projection).filter(({ run }) => run.id !== first.id);
  if (batchableMessage(projection, first) === undefined) return [];
  const members: Array<QueuedRunBatchMember> = [];
  for (const run of queuedRunsInDeliveryOrder(projection)) {
    if (members.length + 1 >= MAX_BATCH_SIZE) break;
    if (run.id === first.id || run.queueHeld === true) continue;
    const message = batchableMessage(projection, run);
    if (message === undefined) {
      if (changesConversation(projection, run)) break;
      continue;
    }
    if (compatibleQueuedRuns(first, run)) {
      members.push({ run, message });
    }
  }
  return members;
}

export function foldedQueuedTurnItems(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  run: Pick<OrchestrationV2Run, "id" | "userMessageId">,
): ReadonlyArray<UserTurnItem> {
  const firstItem = turnItems.find(
    (item) => item.type === "user_message" && item.messageId === run.userMessageId,
  );
  return turnItems
    .filter(
      (item): item is UserTurnItem =>
        item.type === "user_message" &&
        item.runId === run.id &&
        firstItem !== undefined &&
        item.nodeId === firstItem.nodeId &&
        (item.parentItemId === firstItem?.id ||
          (item.parentItemId === null && item.inputIntent === "queued_turn")) &&
        item.messageId !== run.userMessageId,
    )
    .toSorted((left, right) => left.ordinal - right.ordinal);
}

export function queuedRunBatchEvents(input: {
  readonly members: ReadonlyArray<QueuedRunBatchMember>;
  readonly projection: Pick<OrchestrationV2ThreadProjection, "nodes" | "attempts">;
  readonly target: OrchestrationV2Run;
  readonly rootNodeId: NodeId;
  readonly firstItem: UserTurnItem;
  readonly itemId: (messageId: OrchestrationV2ConversationMessage["id"]) => UserTurnItem["id"];
  readonly occurredAt: UserTurnItem["updatedAt"];
  readonly groupUnderFirst?: boolean;
}): ReadonlyArray<DraftEvent> {
  const { target, rootNodeId, firstItem, occurredAt } = input;
  const into = {
    threadId: target.threadId,
    runId: target.id,
    nodeId: rootNodeId,
    providerInstanceId: target.providerInstanceId,
    occurredAt,
  };
  return input.members.flatMap(({ run, message }, index): ReadonlyArray<DraftEvent> => {
    const from = {
      threadId: run.threadId,
      runId: run.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt,
    };
    const node = input.projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
    const attempt = input.projection.attempts.find(
      (candidate) => candidate.id === run.activeAttemptId,
    );
    const item: UserTurnItem = {
      ...firstItem,
      id: input.itemId(message.id),
      ordinal: firstItem.ordinal + index + 1,
      ...(input.groupUnderFirst ? { parentItemId: firstItem.id } : {}),
      messageId: message.id,
      text: message.text,
      attachments: message.attachments,
      createdBy: message.createdBy,
      creationSource: message.creationSource,
    };
    const { context: _context, senderThreadId: _sender, ...base } = item;
    return [
      {
        ...from,
        type: "run.updated",
        payload: { ...run, status: "cancelled", queuePosition: null, completedAt: occurredAt },
      },
      ...(attempt === undefined
        ? []
        : [
            {
              ...from,
              type: "run-attempt.updated" as const,
              payload: { ...attempt, status: "cancelled" as const, completedAt: occurredAt },
            },
          ]),
      ...(node === undefined
        ? []
        : [
            {
              ...from,
              nodeId: node.id,
              type: "node.updated" as const,
              payload: { ...node, status: "cancelled" as const, completedAt: occurredAt },
            },
          ]),
      {
        ...into,
        type: "message.updated",
        payload: { ...message, runId: target.id, nodeId: rootNodeId },
      },
      {
        ...into,
        type: "turn-item.updated",
        payload: {
          ...base,
          ...(message.context ? { context: message.context } : {}),
          ...(message.senderThreadId === undefined
            ? {}
            : { senderThreadId: message.senderThreadId }),
        },
      },
    ];
  });
}

export interface QueuedRunBatchPart {
  readonly text: string;
  readonly createdBy: OrchestrationV2ConversationMessage["createdBy"];
  readonly creationSource: OrchestrationV2ConversationMessage["creationSource"];
  readonly senderThreadId?: OrchestrationV2ConversationMessage["senderThreadId"];
}

function batchSender(part: QueuedRunBatchPart): string {
  if (part.senderThreadId !== undefined) return `an agent in thread ${part.senderThreadId}`;
  return part.createdBy === "user"
    ? `the user (${part.creationSource})`
    : `${part.createdBy} (${part.creationSource})`;
}

export function batchedProviderText(parts: ReadonlyArray<QueuedRunBatchPart>): string {
  if (parts.length < 2) return parts[0]?.text ?? "";
  return [
    `These ${parts.length} messages were queued separately while you were working. They are listed with their senders: task completions first, then queued messages in the order they were sent. Handle each one accordingly.`,
    ...parts.map(
      (part, index) =>
        `Message ${index + 1} of ${parts.length}, from ${batchSender(part)}:\n${part.text}`,
    ),
  ].join("\n\n");
}
