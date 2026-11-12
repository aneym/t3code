import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS aneym_thread_placements (
      thread_id TEXT PRIMARY KEY,
      placement_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    )
  `;
});
