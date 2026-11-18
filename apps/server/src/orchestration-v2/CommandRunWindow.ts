import type {
  MessageId,
  OrchestrationV2Command,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const COMMAND_RUN_WINDOW = 100;

const encodeIdList = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export interface CommandRunWindow {
  readonly newest: number;
  readonly keepRunIds: ReadonlyArray<RunId>;
  readonly keepMessageId?: MessageId;
  readonly openItemRuns?: true;
  readonly deliveryRuns?: true;
  readonly afterOrdinal?: number;
  readonly providerTurnId?: ProviderTurnId;
}

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

export const runWindow = (
  keepRunIds: ReadonlyArray<RunId | undefined>,
  options: Omit<CommandRunWindow, "newest" | "keepRunIds"> = {},
): CommandRunWindow => ({
  newest: COMMAND_RUN_WINDOW,
  keepRunIds: keepRunIds.flatMap((runId) => (runId === undefined ? [] : [runId])),
  ...options,
});

export const messageDispatchWindow = (command: MessageDispatch): CommandRunWindow =>
  runWindow(
    [
      command.manualContinuationOfRunId,
      command.restartContinuationOfRunId,
      command.usageLimitContinuationOfRunId,
      command.steerFollowUpOfRunId,
      command.delegatedCompletion?.parentRunId,
      ...(command.dispatchMode.type === "steer_active" ||
      command.dispatchMode.type === "restart_active"
        ? [command.dispatchMode.targetRunId]
        : []),
    ],
    { keepMessageId: command.messageId },
  );

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
      UNION SELECT json_extract(payload_json, '$.restartContinuationOfRunId')
        FROM orchestration_v2_projection_runs
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
        WHERE message_id = ${window.keepMessageId ?? null} AND thread_id = ${threadId}
      UNION SELECT json_extract(payload_json, '$.delegatedCompletion.delivery.blockedByRunId')
        FROM orchestration_v2_projection_runs
        WHERE run_id IN (SELECT value FROM json_each(${keep})) AND +thread_id = ${threadId}
      UNION SELECT json_extract(payload_json, '$.restartContinuationOfRunId')
        FROM orchestration_v2_projection_runs
        WHERE run_id IN (SELECT value FROM json_each(${keep})) AND +thread_id = ${threadId}
      UNION SELECT * FROM (
        SELECT run_id FROM orchestration_v2_projection_turn_items
        INDEXED BY orchestration_v2_projection_turn_items_user_message_idx
        WHERE thread_id = ${threadId} AND type = 'user_message' AND run_id IS NOT NULL
        ORDER BY ordinal DESC LIMIT ${window.newest}
      )
      ${
        window.openItemRuns === true
          ? sql`UNION SELECT run_id FROM orchestration_v2_projection_turn_items
        INDEXED BY orchestration_v2_projection_turn_items_active_run_idx
        WHERE thread_id = ${threadId} AND status IN ('pending', 'running', 'waiting')`
          : sql``
      }
      ${
        window.deliveryRuns === true
          ? sql`UNION SELECT run_id FROM orchestration_v2_projection_runs
        INDEXED BY orchestration_v2_projection_runs_delegated_delivery_idx
        WHERE thread_id = ${threadId} AND CASE WHEN json_valid(payload_json)
          THEN json_type(payload_json, '$.delegatedCompletion.delivery') = 'object' ELSE 0 END
      UNION SELECT message.run_id FROM orchestration_v2_projection_runs AS run
        INDEXED BY orchestration_v2_projection_runs_delegated_delivery_idx
        CROSS JOIN orchestration_v2_projection_messages AS message
          ON message.message_id = json_extract(run.payload_json, '$.delegatedCompletion.delivery.messageId')
        WHERE run.thread_id = ${threadId} AND CASE WHEN json_valid(run.payload_json)
          THEN json_type(run.payload_json, '$.delegatedCompletion.delivery') = 'object' ELSE 0 END`
          : sql``
      }
      ${
        window.afterOrdinal === undefined
          ? sql``
          : sql`UNION SELECT run_id FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND ordinal > ${window.afterOrdinal}`
      }
      ${
        window.providerTurnId === undefined
          ? sql``
          : sql`UNION SELECT attempt.run_id FROM orchestration_v2_projection_provider_turns AS turn
        CROSS JOIN orchestration_v2_projection_run_attempts AS attempt
          ON attempt.attempt_id = turn.run_attempt_id
        WHERE turn.provider_turn_id = ${window.providerTurnId} AND turn.thread_id = ${threadId}`
      }
    `;
    return encodeIdList([
      ...rows.flatMap((row) => (row.run_id === null ? [] : [row.run_id])),
      ...window.keepRunIds,
    ]);
  },
);
