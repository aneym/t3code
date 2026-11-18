import type { MessageId, OrchestrationV2Command, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const COMMAND_RUN_WINDOW = 100;

const encodeIdList = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export interface CommandRunWindow {
  readonly newest: number;
  readonly keepRunIds: ReadonlyArray<RunId>;
  readonly keepMessageId: MessageId;
}

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

export const messageDispatchWindow = (command: MessageDispatch): CommandRunWindow => ({
  newest: COMMAND_RUN_WINDOW,
  keepRunIds: [
    command.manualContinuationOfRunId,
    command.restartContinuationOfRunId,
    command.usageLimitContinuationOfRunId,
    command.steerFollowUpOfRunId,
    command.delegatedCompletion?.parentRunId,
    ...(command.dispatchMode.type === "steer_active" ||
    command.dispatchMode.type === "restart_active"
      ? [command.dispatchMode.targetRunId]
      : []),
  ].flatMap((runId) => (runId === undefined ? [] : [runId])),
  keepMessageId: command.messageId,
});

export const readCommandWindowRunIds = Effect.fn("ProjectionStore.readCommandWindowRunIds")(
  function* (sql: SqlClient.SqlClient, threadId: ThreadId, window: CommandRunWindow) {
    const keep = encodeIdList(window.keepRunIds);
    const rows = yield* sql<{ readonly run_id: RunId | null }>`
      WITH newest AS MATERIALIZED (
        SELECT run_id, ordinal, requested_at FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} ORDER BY ordinal DESC LIMIT ${window.newest}
      )
      SELECT run_id FROM newest
      UNION SELECT run_id FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId}
          AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
      UNION SELECT run_id FROM orchestration_v2_projection_runs
        INDEXED BY orchestration_v2_projection_runs_last_executed_idx
        WHERE thread_id = ${threadId} AND (completed_at IS NULL) = 1 AND status <> 'queued'
          AND NOT (status = 'cancelled' AND json_extract(payload_json, '$.startedAt') IS NULL)
      UNION SELECT run_id FROM orchestration_v2_projection_runs
        INDEXED BY orchestration_v2_projection_runs_last_executed_idx
        WHERE thread_id = ${threadId} AND (completed_at IS NULL) = 0 AND status <> 'queued'
          AND NOT (status = 'cancelled' AND json_extract(payload_json, '$.startedAt') IS NULL)
          AND completed_at >= (SELECT requested_at FROM newest ORDER BY ordinal ASC LIMIT 1)
      UNION SELECT * FROM (
        SELECT run_id FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND status = 'completed' ORDER BY ordinal DESC LIMIT 1
      )
      UNION SELECT * FROM (
        SELECT run_id FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND (status IN ('completed', 'failed', 'interrupted')
          OR (status = 'cancelled' AND json_extract(payload_json, '$.startedAt') IS NOT NULL))
        ORDER BY ordinal DESC LIMIT 1
      )
      UNION SELECT * FROM (
        SELECT run_id FROM orchestration_v2_projection_runs
        INDEXED BY orchestration_v2_projection_runs_thread_status_idx
        WHERE thread_id = ${threadId} AND status IN ('failed', 'interrupted')
          AND json_extract(payload_json, '$.workspacePreparation.type') = 'worktree'
        ORDER BY ordinal DESC LIMIT 1
      )
      UNION SELECT run_id FROM orchestration_v2_projection_messages
        WHERE message_id = ${window.keepMessageId} AND thread_id = ${threadId}
      UNION SELECT json_extract(payload_json, '$.delegatedCompletion.delivery.blockedByRunId')
        FROM orchestration_v2_projection_runs
        WHERE run_id IN (SELECT value FROM json_each(${keep})) AND +thread_id = ${threadId}
      UNION SELECT * FROM (
        SELECT run_id FROM orchestration_v2_projection_turn_items
        INDEXED BY orchestration_v2_projection_turn_items_user_message_idx
        WHERE thread_id = ${threadId} AND type = 'user_message' AND run_id IS NOT NULL
        ORDER BY ordinal DESC LIMIT ${window.newest}
      )
    `;
    return encodeIdList([
      ...rows.flatMap((row) => (row.run_id === null ? [] : [row.run_id])),
      ...window.keepRunIds,
    ]);
  },
);
