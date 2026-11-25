import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_chat_session_set_url_grants (
      grant_key TEXT NOT NULL,
      set_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (grant_key, set_id)
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO auth_chat_session_set_url_grants (grant_key, set_id, expires_at)
    SELECT grant_key, set_id, expires_at FROM auth_chat_session_url_grants
  `;
});
