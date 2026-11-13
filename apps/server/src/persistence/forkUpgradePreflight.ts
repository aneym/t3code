// @effect-diagnostics nodeBuiltinImport:off - read synchronously by the preflight subprocess and at startup.
import * as NodeSqlite from "node:sqlite";

import { migrationManifest } from "./Migrations.ts";

type MigrationRow = { readonly id: number; readonly name: string };

const UPSTREAM_SHARED_HEAD = 76;

const upstreamCreatedNames = [
  [79, "orchestration_v2_projection_threads_subagent_result_idx"],
  [79, "orchestration_v2_projection_runs_delegated_delivery_idx"],
  [85, "orchestration_v2_projection_turn_item_counts"],
  [85, "orchestration_v2_turn_item_counts_insert"],
  [85, "orchestration_v2_turn_item_counts_update"],
  [85, "orchestration_v2_turn_item_counts_delete"],
  [86, "orchestration_v2_projection_turn_items_queued_input_idx"],
] as const;

const upstreamAddedColumns = [
  [80, "scheduled_tasks", "thread_mode"],
  [81, "orchestration_v2_projection_messages", "search_text"],
] as const;

const forkUpstreamStyleNames = new Set([
  "orchestration_v2_projection_provider_turns_attempt_idx",
  "orchestration_v2_projection_runs_user_message_idx",
]);

export function sharedHistoryGaps(recorded: ReadonlyArray<MigrationRow>): string[] {
  const head = Math.min(UPSTREAM_SHARED_HEAD, Math.max(0, ...recorded.map(({ id }) => id)));
  const names = new Map(recorded.map((row) => [row.id, row.name]));
  return migrationManifest.flatMap(([id, name]) =>
    id > head || names.get(id) === name
      ? []
      : [`${id}_${name} (recorded: ${names.get(id) ?? "nothing"})`],
  );
}

export function pendingSchemaCollisions(
  databasePath: string,
  recorded: ReadonlyArray<MigrationRow>,
): string[] | null {
  const head = Math.max(0, ...recorded.map(({ id }) => id));
  const names = upstreamCreatedNames.filter(([id]) => id > head);
  const columns = upstreamAddedColumns.filter(([id]) => id > head);
  if (names.length === 0 && columns.length === 0) return [];
  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const existing = new Set(
      db
        .prepare("SELECT name FROM sqlite_master")
        .all()
        .map((row) => String(row.name)),
    );
    const columnExists = db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?");
    return [
      ...names
        .filter(([, name]) => existing.has(name) || forkUpstreamStyleNames.has(name))
        .map(([id, name]) => `${name} (created by migration ${id})`),
      ...columns
        .filter(([, table, column]) => columnExists.get(table, column) !== undefined)
        .map(([id, table, column]) => `${table}.${column} (added by migration ${id})`),
    ];
  } catch {
    return null;
  } finally {
    db.close();
  }
}
