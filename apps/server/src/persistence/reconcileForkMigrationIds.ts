import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const forkMigrationNames = ["ProjectionThreadAutomationPlacement", "ProjectionProjectsPinOrder"];
const forkMigrationIds = [70, 71, 73, 74];
const completionDeliveryIndexes = { id: 75, name: "CompletionDeliveryIndexes" };

export const isRelocatedForkMigration = (row: { readonly id: number; readonly name: string }) =>
  (row.id === completionDeliveryIndexes.id && row.name === completionDeliveryIndexes.name) ||
  (forkMigrationIds.includes(row.id) && forkMigrationNames.includes(row.name));

export const reconcileForkMigrationIds = Effect.fn("reconcileForkMigrationIds")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  yield* sql`
    DELETE FROM effect_sql_migrations
    WHERE migration_id = ${completionDeliveryIndexes.id} AND name = ${completionDeliveryIndexes.name}
  `;
  yield* sql`
    DELETE FROM effect_sql_migrations
    WHERE migration_id IN ${sql.in(forkMigrationIds)} AND name IN ${sql.in(forkMigrationNames)}
  `;
});
