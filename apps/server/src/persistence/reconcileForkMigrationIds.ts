import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const forkMigrationNames = ["ProjectionThreadAutomationPlacement", "ProjectionProjectsPinOrder"];

export const reconcileForkMigrationIds = Effect.fn("reconcileForkMigrationIds")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  yield* sql`
    DELETE FROM effect_sql_migrations
    WHERE migration_id = 75 AND name = 'CompletionDeliveryIndexes'
  `;
  yield* sql`
    DELETE FROM effect_sql_migrations
    WHERE migration_id IN (70, 71, 73, 74) AND name IN ${sql.in(forkMigrationNames)}
  `;
});
