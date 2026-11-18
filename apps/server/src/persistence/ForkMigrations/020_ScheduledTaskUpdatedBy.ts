import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (columns.some((column) => column.name === "updated_by")) return;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN updated_by TEXT`;
});
