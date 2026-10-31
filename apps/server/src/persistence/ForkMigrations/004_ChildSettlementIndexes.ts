import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS aneym_settled_parents_idx
    ON orchestration_v2_projection_threads(thread_id)
    WHERE deleted_at IS NULL
      AND json_extract(payload_json, '$.settledOverride') = 'settled'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS aneym_unsettled_children_parent_idx
    ON orchestration_v2_projection_threads(json_extract(payload_json, '$.lineage.parentThreadId'), thread_id)
    WHERE deleted_at IS NULL
      AND json_extract(payload_json, '$.archivedAt') IS NULL
      AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
      AND json_extract(payload_json, '$.settledOverride') IS NULL
  `;
});
