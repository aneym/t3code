import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE peer_environment_links ADD COLUMN renewed_at TEXT`;
  yield* sql`ALTER TABLE peer_environment_links ADD COLUMN renewal_error TEXT`;
});
