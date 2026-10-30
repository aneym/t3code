import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const explicitMark = (alias: string) => `(
  ${alias}.command_id LIKE '%:thread-update:%:mark_automation:%'
  OR json_extract(${alias}.payload_json, '$.automationTaskId') = 'automation:thread:' || ${alias}.stream_id
)`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.automationPlacementAt', occurred_at)
    WHERE application_event_version = 2
      AND aggregate_kind = 'thread'
      AND event_type = 'thread.metadata-updated'
      AND json_extract(payload_json, '$.automationTaskId') IS NOT NULL
      AND ${sql.literal(explicitMark("orchestration_events"))}
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_set(
      payload_json,
      '$.automationPlacementAt',
      (
        SELECT MAX(events.occurred_at)
        FROM orchestration_events events
        WHERE events.application_event_version = 2
          AND events.aggregate_kind = 'thread'
          AND events.stream_id = orchestration_v2_projection_threads.thread_id
          AND events.event_type = 'thread.metadata-updated'
          AND json_extract(events.payload_json, '$.automationTaskId') IS NOT NULL
          AND ${sql.literal(explicitMark("events"))}
          AND events.sequence > COALESCE((
            SELECT MAX(unmarks.sequence)
            FROM orchestration_events unmarks
            WHERE unmarks.application_event_version = 2
              AND unmarks.aggregate_kind = 'thread'
              AND unmarks.stream_id = orchestration_v2_projection_threads.thread_id
              AND unmarks.event_type = 'thread.metadata-updated'
              AND json_extract(unmarks.payload_json, '$.automationTaskId') IS NULL
              AND unmarks.command_id NOT LIKE 'scheduled-task:%'
          ), 0)
      )
    )
    WHERE json_extract(payload_json, '$.automationTaskId') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM orchestration_events events
        WHERE events.application_event_version = 2
          AND events.aggregate_kind = 'thread'
          AND events.stream_id = orchestration_v2_projection_threads.thread_id
          AND events.event_type = 'thread.metadata-updated'
          AND json_extract(events.payload_json, '$.automationTaskId') IS NOT NULL
          AND ${sql.literal(explicitMark("events"))}
          AND events.sequence > COALESCE((
            SELECT MAX(unmarks.sequence)
            FROM orchestration_events unmarks
            WHERE unmarks.application_event_version = 2
              AND unmarks.aggregate_kind = 'thread'
              AND unmarks.stream_id = orchestration_v2_projection_threads.thread_id
              AND unmarks.event_type = 'thread.metadata-updated'
              AND json_extract(unmarks.payload_json, '$.automationTaskId') IS NULL
              AND unmarks.command_id NOT LIKE 'scheduled-task:%'
          ), 0)
      )
  `;
});
