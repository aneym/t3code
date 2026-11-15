import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_chat_session_url_grants (
      grant_key TEXT PRIMARY KEY,
      set_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `;
});
