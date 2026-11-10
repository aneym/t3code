import type { OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

type InputIntent = Extract<OrchestrationV2TurnItem, { type: "user_message" }>["inputIntent"];

export interface TimelineIndexSqlRow {
  readonly turn_item_id: string;
  readonly run_id: string | null;
  readonly node_id: string | null;
  readonly parent_item_id: string | null;
  readonly type: OrchestrationV2TurnItem["type"];
  readonly input_intent: NonNullable<InputIntent> | null;
  readonly created_by: "user" | "agent" | "system" | null;
  readonly message_id: string | null;
  readonly status: OrchestrationV2TurnItem["status"];
  readonly ordinal: number;
  readonly persistent_output: number;
  readonly attempt_id: string | null;
  readonly attempt_status: string | null;
}

export const makeTimelineIndexRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return Effect.fn("ProjectionStore.selectTimelineIndexRows")(function* (input: {
    readonly threadId: ThreadId;
    readonly persistentOutput: Statement.Fragment | null;
    readonly messageFields: boolean;
  }) {
    const { threadId, persistentOutput } = input;
    const rows =
      yield* sql<TimelineIndexSqlRow>`SELECT item.turn_item_id, item.run_id, item.node_id, item.parent_item_id, item.type, item.status, item.ordinal,
          ${persistentOutput === null ? sql`NULL` : sql`attempt.attempt_id`} AS attempt_id,
          ${persistentOutput === null ? sql`NULL` : sql`attempt.status`} AS attempt_status,
          ${persistentOutput === null ? sql`0` : sql`CASE WHEN ${persistentOutput} THEN 1 ELSE 0 END`} AS persistent_output,
          ${
            input.messageFields
              ? sql`CASE WHEN item.type = 'user_message' THEN json_extract(item.payload_json, '$.inputIntent') END AS input_intent,
          CASE WHEN item.type = 'user_message' THEN json_extract(item.payload_json, '$.createdBy') END AS created_by,
          CASE WHEN item.type IN ('user_message', 'assistant_message') THEN json_extract(item.payload_json, '$.messageId') END AS message_id`
              : sql`NULL AS input_intent, NULL AS created_by, NULL AS message_id`
          }
        FROM orchestration_v2_projection_turn_items AS item
        ${
          persistentOutput === null
            ? sql``
            : sql`LEFT JOIN orchestration_v2_projection_nodes AS node ON node.node_id = item.node_id
        LEFT JOIN orchestration_v2_projection_run_attempts AS attempt ON attempt.attempt_id = (
          SELECT attempt_id FROM orchestration_v2_projection_run_attempts
          WHERE run_id = item.run_id AND root_node_id = COALESCE(node.root_node_id, item.node_id)
          ORDER BY attempt_ordinal DESC LIMIT 1
        )`
        }
        WHERE item.thread_id = ${threadId}
        ORDER BY item.ordinal ASC, item.turn_item_id ASC`;
    if (input.messageFields) return rows;
    const intents = yield* sql<{
      readonly turn_item_id: string;
      readonly input_intent: NonNullable<InputIntent> | null;
    }>`SELECT item.turn_item_id, json_extract(item.payload_json, '$.inputIntent') AS input_intent
        FROM orchestration_v2_projection_runs AS run
        CROSS JOIN orchestration_v2_projection_turn_items AS item
          ON item.thread_id = run.thread_id AND item.run_id = run.run_id
        WHERE run.thread_id = ${threadId} AND run.status = 'cancelled' AND item.type = 'user_message'`;
    if (intents.length === 0) return rows;
    const byId = new Map(intents.map((row) => [row.turn_item_id, row.input_intent]));
    return rows.map((row) => {
      const inputIntent = byId.get(row.turn_item_id);
      return inputIntent === undefined ? row : { ...row, input_intent: inputIntent };
    });
  });
});
