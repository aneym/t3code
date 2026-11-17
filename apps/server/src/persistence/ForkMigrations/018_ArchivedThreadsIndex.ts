import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS aneym_archived_threads_idx
    ON orchestration_v2_projection_threads(archived_at, thread_id)
    WHERE archived_at IS NOT NULL AND deleted_at IS NULL
  `;
});
