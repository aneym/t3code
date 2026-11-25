import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(aneym_mcp_events_subscriptions)`;
  if (columns.some((column) => column.name === "delivery_url")) return;
  yield* sql`ALTER TABLE aneym_mcp_events_subscriptions ADD COLUMN delivery_url TEXT`;
});
