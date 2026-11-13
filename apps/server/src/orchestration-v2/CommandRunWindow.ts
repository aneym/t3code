import type { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

const COMMAND_RECENT_RUNS = 64;

export interface CommandRunWindow {
  readonly runIds: ReadonlyArray<RunId>;
}

export const recentAndOpenRuns = { runWindow: { runIds: [] } } satisfies {
  readonly runWindow: CommandRunWindow;
};

export const readCommandRunWindow = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  window: CommandRunWindow | undefined,
) =>
  window === undefined
    ? Effect.succeed(null)
    : sql<{ readonly run_id: string }>`
        SELECT run.run_id FROM orchestration_v2_projection_runs AS run
        WHERE run.thread_id = ${threadId} AND (
          run.ordinal >= (SELECT MIN(ordinal) FROM (
            SELECT ordinal FROM (
              SELECT ordinal FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId} ORDER BY ordinal DESC LIMIT ${COMMAND_RECENT_RUNS})
            UNION ALL
            SELECT ordinal FROM (
              SELECT ordinal FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId} AND completed_at IS NOT NULL
              ORDER BY completed_at DESC LIMIT ${COMMAND_RECENT_RUNS})))
          OR run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
          OR run.completed_at IS NULL
          OR run.run_id = (
            SELECT run_id FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND status = 'completed'
            ORDER BY ordinal DESC LIMIT 1)
          OR (run.status IN ('failed', 'interrupted')
            AND json_extract(run.payload_json, '$.workspacePreparation.type') = 'worktree')
          OR run.run_id IN (
            SELECT run_id FROM orchestration_v2_projection_subagents
            WHERE thread_id = ${threadId} AND run_id IS NOT NULL AND NOT (
              status IN ('completed', 'failed', 'cancelled', 'interrupted')
              AND COALESCE(completion_delivery_state, '') IN ('acknowledged', 'delivered', 'disposed')))
          OR run.run_id IN (SELECT value FROM json_each(${JSON.stringify(window.runIds)})))
      `.pipe(Effect.map((rows) => JSON.stringify(rows.map((row) => row.run_id))));

export const inCommandRunWindow = (sql: SqlClient.SqlClient, runWindow: string | null) =>
  runWindow === null
    ? sql``
    : sql`AND (run_id IS NULL OR run_id IN (SELECT value FROM json_each(${runWindow})))`;

export const inCommandRunWindowAttempts = (sql: SqlClient.SqlClient, runWindow: string | null) =>
  runWindow === null
    ? sql``
    : sql`AND (run_attempt_id IS NULL OR run_attempt_id IN (
        SELECT attempt_id FROM orchestration_v2_projection_run_attempts
        WHERE run_id IN (SELECT value FROM json_each(${runWindow}))))`;

export const commandRunWindowMessagesWhere = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  runWindow: string | null,
) =>
  runWindow === null
    ? sql`thread_id = ${threadId}`
    : sql`+thread_id = ${threadId} AND rowid IN (
        SELECT rowid FROM orchestration_v2_projection_messages
          INDEXED BY orchestration_v2_projection_messages_thread_run_idx
        WHERE thread_id = ${threadId} AND run_id IS NULL
        UNION ALL
        SELECT rowid FROM orchestration_v2_projection_messages
          INDEXED BY orchestration_v2_projection_messages_thread_run_idx
        WHERE thread_id = ${threadId}
          AND run_id IN (SELECT value FROM json_each(${runWindow})))`;
