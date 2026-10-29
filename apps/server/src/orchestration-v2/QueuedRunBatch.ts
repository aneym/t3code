import {
  parseGoalCommand,
  type NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { modelSelectionsEqual } from "@t3tools/shared/model";

import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

const MAX_BATCH_SIZE = 20;

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

function batchableMessage(
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
  run: OrchestrationV2Run,
): OrchestrationV2ConversationMessage | undefined {
  if (
    run.status !== "queued" ||
    run.queueHeld === true ||
    run.restartContinuationOfRunId !== undefined ||
    run.delegatedTaskId !== undefined ||
    run.sourcePlanRef !== undefined
  ) {
    return undefined;
  }
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  if (
    message === undefined ||
    message.notification !== undefined ||
    message.workflowScript === true ||
    message.scheduledTaskId !== undefined ||
    message.idleCompaction !== undefined ||
    message.text.trimStart().startsWith("/") ||
    isNativeMaintenanceCommand(message) ||
    parseGoalCommand(message) !== null
  ) {
    return undefined;
  }
  return message;
}

export function queuedRunBatch(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  first: OrchestrationV2Run,
): ReadonlyArray<QueuedRunBatchMember> {
  if (batchableMessage(projection, first) === undefined) return [];
  const members: Array<QueuedRunBatchMember> = [];
  for (const run of queuedRunsInDeliveryOrder(projection)) {
    if (run.id === first.id) continue;
    const message = batchableMessage(projection, run);
    if (
      message === undefined ||
      run.providerInstanceId !== first.providerInstanceId ||
      !modelSelectionsEqual(run.modelSelection, first.modelSelection) ||
      run.workspacePreparation?.type !== first.workspacePreparation?.type ||
      members.length + 1 >= MAX_BATCH_SIZE
    ) {
      break;
    }
    members.push({ run, message });
  }
  return members;
}

function foldedQueuedTurnItems(
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
        item.inputIntent === "queued_turn" &&
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

function batchedProviderText(parts: ReadonlyArray<QueuedRunBatchPart>): string {
  if (parts.length < 2) return parts[0]?.text ?? "";
  return [
    `These ${parts.length} messages were queued separately while you were working. They are listed with their senders: task completions first, then queued messages in the order they were sent. Handle each one accordingly.`,
    ...parts.map(
      (part, index) =>
        `Message ${index + 1} of ${parts.length}, from ${batchSender(part)}:\n${part.text}`,
    ),
  ].join("\n\n");
}

export function unacceptedSourceOf(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
  run: Pick<OrchestrationV2Run, "restartContinuationOfRunId">,
): OrchestrationV2Run | undefined {
  return projection.runs.find(
    (source) =>
      source.id === run.restartContinuationOfRunId &&
      !projection.providerTurns.some((turn) => turn.runAttemptId === source.activeAttemptId),
  );
}

function everAccepted(
  projection: Pick<OrchestrationV2ThreadProjection, "attempts" | "providerTurns">,
  run: Pick<OrchestrationV2Run, "id">,
): boolean {
  return projection.attempts.some(
    (attempt) =>
      attempt.runId === run.id &&
      projection.providerTurns.some((turn) => turn.runAttemptId === attempt.id),
  );
}

export function unacceptedContinuationChain(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
  run: Pick<OrchestrationV2Run, "id" | "restartContinuationOfRunId">,
): ReadonlyArray<OrchestrationV2Run> {
  const chain: Array<OrchestrationV2Run> = [];
  let from: Pick<OrchestrationV2Run, "id" | "restartContinuationOfRunId"> = run;
  let source = unacceptedSourceOf(projection, from);
  while (source !== undefined && !chain.includes(source) && !everAccepted(projection, from)) {
    chain.push(source);
    from = source;
    source = unacceptedSourceOf(projection, from);
  }
  return chain;
}

export function unacceptedAttemptItems(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  source: Pick<OrchestrationV2Run, "rootNodeId">,
): ReadonlyArray<OrchestrationV2TurnItem> {
  return items.filter((item) => item.nodeId === source.rootNodeId);
}

export function batchedProviderPrompt(
  message: OrchestrationV2ConversationMessage,
  owner: Pick<OrchestrationV2Run, "id" | "userMessageId">,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
) {
  const folded = foldedQueuedTurnItems(turnItems, owner);
  const origin =
    turnItems.find(
      (item): item is UserTurnItem =>
        item.type === "user_message" && item.messageId === owner.userMessageId,
    ) ?? message;
  return {
    text: batchedProviderText(
      [{ ...origin, text: message.text, context: message.context }, ...folded].map((part) => ({
        ...part,
        text: projectComposerContextForProvider({
          text: part.text,
          records: part.context?.records ?? [],
        }),
      })),
    ),
    attachments: [...message.attachments, ...folded.flatMap((item) => item.attachments)],
    foldedItems: folded,
  };
}

export function unpromptedHistory(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  runs: ReadonlyArray<OrchestrationV2Run>,
  run: OrchestrationV2Run,
  chain: ReadonlyArray<OrchestrationV2Run>,
  foldedItems: ReadonlyArray<UserTurnItem>,
): ReadonlyArray<OrchestrationV2TurnItem> {
  const replayed = new Set([
    ...[run, ...chain].map((source) => source.userMessageId),
    ...foldedItems.map((item) => item.messageId),
  ]);
  return items.filter(
    (item) =>
      (item.runId === null ||
        runs.some((source) => source.id === item.runId && source.ordinal <= run.ordinal)) &&
      !(item.type === "user_message" && replayed.has(item.messageId)),
  );
}
