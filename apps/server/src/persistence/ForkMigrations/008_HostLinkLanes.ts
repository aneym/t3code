import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS aneym_host_link_lanes (
      thread_id TEXT PRIMARY KEY,
      lane TEXT NOT NULL,
      bound_at TEXT NOT NULL
    )
  `;
});
