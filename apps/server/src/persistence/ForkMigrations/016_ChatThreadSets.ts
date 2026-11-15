import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_chat_thread_sets (
      set_id TEXT PRIMARY KEY,
      thread_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
