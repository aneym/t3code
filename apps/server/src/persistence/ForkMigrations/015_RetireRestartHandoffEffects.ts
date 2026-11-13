import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_effect_outbox (
      effect_id,
      command_id,
      thread_id,
      effect_type,
      payload_json,
      status,
      attempt_count,
      available_at,
      created_at,
      updated_at
    )
    SELECT
      'effect:restart-continuation:' || run.value,
      'command:restart-prepare:' || run.value,
      handoff.thread_id,
      'provider-runtime.continue',
      json_object('type', 'provider-runtime.continue', 'sourceRunId', run.value),
      'pending',
      0,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM orchestration_v2_effect_outbox AS handoff,
      json_each(
        handoff.payload_json,
        CASE
          WHEN json_type(handoff.payload_json, '$.handoff.sourceRunIds') = 'array'
            THEN '$.handoff.sourceRunIds'
          ELSE '$.handoff.runIds'
        END
      ) AS run
    WHERE handoff.effect_type = 'provider-runtime.restart-handoff'
      AND handoff.status IN ('pending', 'running')
      AND run.type = 'text'
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(handoff.payload_json, '$.handoff.pausedRunIds') AS paused
        WHERE paused.value = run.value
      )
    ON CONFLICT(effect_id) DO NOTHING
  `;
  yield* sql`
    UPDATE orchestration_v2_effect_outbox
    SET
      status = 'cancelled',
      lease_owner = NULL,
      completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      last_error = 'Cancelled when restart handoff was retired.'
    WHERE effect_type IN ('provider-runtime.restart-handoff', 'provider-runtime.restart-reapproval')
      AND status IN ('pending', 'running')
  `;
});
