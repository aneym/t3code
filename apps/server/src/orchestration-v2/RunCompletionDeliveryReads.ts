import type { RunId, ThreadId } from "@t3tools/contracts";
import type * as SqlClient from "effect/sql/SqlClient";

export const runCompletionDeliveryRows = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  runId: RunId,
) =>
  sql<{ readonly payload_json: string; readonly accepted: number }>`
    SELECT m.payload_json, EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS r
      JOIN orchestration_v2_projection_provider_turns AS t ON t.thread_id = r.thread_id
        AND t.run_attempt_id = json_extract(r.payload_json, '$.activeAttemptId')
      WHERE r.run_id = ${runId}) AS accepted
    FROM orchestration_v2_projection_messages AS m
    WHERE m.run_id = ${runId} AND m.thread_id = ${threadId} AND m.role = 'user'
      AND json_extract(m.payload_json, '$.delegatedCompletion') IS NOT NULL
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
        AND json_extract(payload_json, '$.userMessageId') = m.message_id)`;
