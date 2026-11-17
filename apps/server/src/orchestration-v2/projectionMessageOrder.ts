import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const encodeIdList = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

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

export const readMessageOrdinals = Effect.fn("ProjectionStore.readMessageOrdinals")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  named: boolean,
) {
  const rows = yield* sql<{ message_id: string; ordinal: number }>`
    SELECT json_extract(payload_json, '$.messageId') AS message_id, MIN(ordinal) AS ordinal
    FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ${threadId}
      AND ${
        messages.every((message) => message.role === "user")
          ? sql`type = 'user_message'`
          : sql`type IN ('user_message', 'assistant_message')`
      }
      ${named ? sql`AND json_extract(payload_json, '$.messageId') IN (SELECT value FROM json_each(${encodeIdList(messages.map((message) => message.id))}))` : sql``}
    GROUP BY json_extract(payload_json, '$.messageId')`;
  return new Map(rows.map((row) => [row.message_id, row.ordinal]));
});
