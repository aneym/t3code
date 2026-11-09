import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const ORDERING_TYPES = ["user_message", "assistant_message"] as const;

export function turnItemsOrderLoadedMessages(
  filter:
    | {
        readonly messageRoles?: ReadonlyArray<OrchestrationV2ConversationMessage["role"]>;
        readonly turnItemTypes?: ReadonlyArray<OrchestrationV2TurnItem["type"]>;
        readonly turnItemStatuses?: ReadonlyArray<unknown>;
        readonly turnItemRunId?: unknown;
        readonly turnItemRunIds?: ReadonlyArray<unknown>;
        readonly turnItemNodeIds?: ReadonlyArray<unknown>;
      }
    | undefined,
  loadedUnwindowed: boolean,
): boolean {
  if (
    !loadedUnwindowed ||
    filter?.turnItemStatuses !== undefined ||
    filter?.turnItemRunId !== undefined ||
    filter?.turnItemRunIds !== undefined ||
    filter?.turnItemNodeIds !== undefined
  )
    return false;
  const loaded: ReadonlyArray<OrchestrationV2TurnItem["type"]> =
    filter?.turnItemTypes ?? ORDERING_TYPES;
  const needed = filter?.messageRoles?.every((role) => role === "user")
    ? (["user_message"] as const)
    : ORDERING_TYPES;
  return needed.every((type) => loaded.includes(type));
}

function messageIdForTurnItem(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      return item.messageId;
    default:
      return null;
  }
}

export function sortMessagesByTurnItemOrder(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  messageOrdinals = new Map<string, number>(),
): Array<OrchestrationV2ConversationMessage> {
  for (const turnItem of turnItems) {
    const messageId = messageIdForTurnItem(turnItem);
    if (messageId === null) {
      continue;
    }
    const existing = messageOrdinals.get(messageId);
    if (existing === undefined || turnItem.ordinal < existing) {
      messageOrdinals.set(messageId, turnItem.ordinal);
    }
  }

  return messages.toSorted((left, right) => {
    const leftOrdinal = messageOrdinals.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrdinal = messageOrdinals.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrdinal !== rightOrdinal) {
      return leftOrdinal - rightOrdinal;
    }

    const leftCreatedAt = DateTime.toEpochMillis(left.createdAt);
    const rightCreatedAt = DateTime.toEpochMillis(right.createdAt);
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }

    return left.id.localeCompare(right.id);
  });
}
