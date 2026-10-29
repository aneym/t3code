#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  MigrateDevDbNotInWorktreeError,
  MigrateDevDbSharedHomeError,
  MigrateDevDbSourceMissingError,
  MigrateDevDbSourceIsDestinationError,
  MigrateDevDbSlotCollisionError,
  MigrateDevDbPhaseError,
} from "./devDbMigrationErrors.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, Flag } from "effect/cli";

import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import { rebuildMessageSearch } from "../src/orchestration-v2/messageSearchIndex.ts";
import { migrationManifest, runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ensureNotInUse, liveDevDbServerPid } from "./devDbRuntime.ts";
import { snapshotDevDb } from "./devDbSnapshot.ts";

export interface RunMigrateDevDbInput {
  readonly baseDir?: string | undefined;
  readonly source?: string | undefined;
  readonly projects: number;
  readonly threadsPerProject: number;
}

export interface RunMigrateDevDbOptions {
  readonly sharedHome?: string | undefined;
}

interface KeptProject {
  readonly title: string;
  readonly threads: number;
}

const removeDatabaseFiles = Effect.fn("removeDatabaseFiles")(function* (databasePath: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const suffix of ["", "-wal", "-shm"]) {
    yield* fs.remove(`${databasePath}${suffix}`).pipe(Effect.orElseSucceed(() => undefined));
  }
});

const RECOVERY_KINDS: ReadonlyArray<ProjectionStore.ProjectionRecoveryKind> = [
  "queued-runs",
  "runtime",
  "subagent-results",
  "delegated-completions",
];

const CLEARED_TABLES: ReadonlyArray<string> = [
  "scheduled_tasks",
  "orchestration_v2_effect_outbox",
  "orchestration_v2_thread_launch_workflows",
  "orchestration_command_receipts",
  "provider_session_runtime",
  "auth_sessions",
  "auth_pairing_links",
];

const PROVIDER_SESSIONS_TABLE = "orchestration_v2_projection_provider_sessions";
const FTS5_SHADOW_SUFFIXES = ["_data", "_idx", "_content", "_docsize", "_config"];

const rootIsVisible = (sql: SqlClient.SqlClient) => sql`
  root.deleted_at IS NULL
  AND json_extract(root.payload_json, '$.deletedAt') IS NULL
  AND json_extract(root.payload_json, '$.archivedAt') IS NULL`;

const copySourceSlice = Effect.fn("copyDevDbSourceSlice")(function* (sourcePath: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ATTACH DATABASE ${`${NodeURL.pathToFileURL(sourcePath).href}?mode=ro`} AS src`;
  const schema = yield* sql<{ type: string; name: string; sql: string }>`
    SELECT type, name, sql FROM src.sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`;
  const threadColumns = yield* sql<{ name: string; notnull: number }>`
    SELECT m.name, c."notnull" FROM src.sqlite_master m, pragma_table_info(m.name, 'src') c
    WHERE m.type = 'table' AND c.name = 'thread_id'`;
  const threadIdNullable = new Map(threadColumns.map((row) => [row.name, row.notnull === 0]));
  const virtualTables = schema
    .filter((entry) => entry.type === "table" && /^CREATE VIRTUAL TABLE/i.test(entry.sql))
    .map((entry) => entry.name);
  const isShadowTable = (name: string) =>
    virtualTables.some((virtual) =>
      FTS5_SHADOW_SUFFIXES.some((suffix) => name === `${virtual}${suffix}`),
    );
  const tables = schema.filter((entry) => entry.type === "table" && !isShadowTable(entry.name));
  const filtered = tables.some((table) => table.name === "orchestration_v2_projection_threads");
  const references = yield* sql<{ name: string; parent: string }>`
    SELECT m.name, f."table" AS parent FROM src.sqlite_master m, pragma_foreign_key_list(m.name, 'src') f
    WHERE m.type = 'table'`;
  const cleared = new Set(CLEARED_TABLES);
  for (let grew = true; grew;) {
    grew = false;
    for (const { name, parent } of references) {
      if (cleared.has(parent) && !cleared.has(name)) {
        cleared.add(name);
        grew = true;
      }
    }
  }

  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const table of tables) yield* sql.unsafe(table.sql).unprepared;
      if (filtered) {
        yield* sql`CREATE TEMP TABLE copied_threads (thread_id TEXT PRIMARY KEY)`;
        yield* sql`INSERT OR IGNORE INTO copied_threads
          SELECT family.thread_id FROM src.orchestration_v2_projection_threads family
          JOIN src.orchestration_v2_projection_threads root ON root.thread_id =
            COALESCE(json_extract(family.payload_json, '$.lineage.rootThreadId'), family.thread_id)
          WHERE ${rootIsVisible(sql)}`;
      }
      for (const { name } of tables) {
        if (cleared.has(name) || virtualTables.includes(name)) continue;
        const nullable = threadIdNullable.get(name);
        const filter = !filtered
          ? ""
          : name === "orchestration_events"
            ? `WHERE (aggregate_kind = 'thread' AND stream_id IN (SELECT thread_id FROM copied_threads))
                OR aggregate_kind < 'thread' OR aggregate_kind > 'thread'`
            : nullable === undefined || name === PROVIDER_SESSIONS_TABLE
              ? ""
              : `WHERE thread_id IN (SELECT thread_id FROM copied_threads)${nullable ? " OR thread_id IS NULL" : ""}`;
        yield* sql.unsafe(`INSERT INTO main."${name}" SELECT * FROM src."${name}" ${filter}`)
          .unprepared;
      }
      yield* sql`DELETE FROM main.sqlite_sequence`;
      yield* sql`INSERT INTO main.sqlite_sequence SELECT name, seq FROM src.sqlite_sequence`;
      for (const entry of schema) {
        if (entry.type !== "table") yield* sql.unsafe(entry.sql).unprepared;
      }
      yield* rebuildMessageSearch(sql);
    }),
  );
  yield* sql`DETACH DATABASE src`;
});

const pruneSnapshot = Effect.fn("pruneDevDbSnapshot")(function* (input: RunMigrateDevDbInput) {
  const sql = yield* SqlClient.SqlClient;

  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const recoveryThreadIds = yield* Effect.forEach(RECOVERY_KINDS, (kind) =>
    projections.getRecoveryThreadIds(kind),
  );
  yield* sql`CREATE TEMP TABLE live_threads (thread_id TEXT PRIMARY KEY)`;
  for (const threadId of new Set(recoveryThreadIds.flat())) {
    yield* sql`INSERT INTO live_threads (thread_id) VALUES (${threadId})`;
  }
  yield* sql`INSERT OR IGNORE INTO live_threads (thread_id)
    SELECT r.thread_id FROM orchestration_v2_projection_runs r
    WHERE r.status = 'failed' AND r.ordinal = (
      SELECT MAX(latest.ordinal) FROM orchestration_v2_projection_runs latest
      WHERE latest.thread_id = r.thread_id)
    UNION
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE json_extract(payload_json, '$.limitRecovery') IS NOT NULL`;

  yield* sql`CREATE TEMP TABLE thread_families AS
    SELECT thread_id, updated_at,
      COALESCE(json_extract(payload_json, '$.lineage.rootThreadId'), thread_id) AS root_id
    FROM orchestration_v2_projection_threads`;

  yield* sql`CREATE TEMP TABLE stopped_families AS
    SELECT f.root_id, root.project_id, MAX(f.updated_at) AS updated_at, COUNT(*) AS size
    FROM thread_families f
    JOIN orchestration_v2_projection_threads root ON root.thread_id = f.root_id
    WHERE ${rootIsVisible(sql)}
    GROUP BY f.root_id, root.project_id
    HAVING SUM(f.thread_id IN (SELECT thread_id FROM live_threads)) = 0`;

  yield* sql`CREATE TEMP TABLE kept_projects AS
    SELECT p.project_id
    FROM projection_projects p
    LEFT JOIN (
      SELECT project_id, MAX(updated_at) AS last_stopped_at
      FROM stopped_families
      GROUP BY project_id
    ) q ON q.project_id = p.project_id
    WHERE p.deleted_at IS NULL
    ORDER BY (q.last_stopped_at IS NULL) ASC,
      COALESCE(q.last_stopped_at, p.updated_at) DESC
    LIMIT ${input.projects}`;

  yield* sql`CREATE TEMP TABLE kept_threads AS
    SELECT f.thread_id FROM thread_families f
    WHERE f.root_id IN (
      SELECT root_id FROM (
        SELECT
          sf.root_id,
          ROW_NUMBER() OVER (
            PARTITION BY sf.project_id
            ORDER BY sf.updated_at DESC
          ) AS recency_rank
        FROM stopped_families sf
        JOIN kept_projects kp ON kp.project_id = sf.project_id
        WHERE sf.size <= ${input.threadsPerProject}
      )
      WHERE recency_rank <= ${input.threadsPerProject}
    )`;

  const threadTables = yield* sql<{ name: string }>`
    SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c
    WHERE m.type = 'table' AND c.name = 'thread_id'
      AND m.name <> ${PROVIDER_SESSIONS_TABLE}`;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM projection_projects
        WHERE project_id NOT IN (SELECT project_id FROM kept_projects)`;
      yield* sql`DELETE FROM ${sql(PROVIDER_SESSIONS_TABLE)}
        WHERE COALESCE(thread_id, '') NOT IN (SELECT thread_id FROM kept_threads)
          AND provider_session_id NOT IN (
            SELECT provider_session_id FROM orchestration_v2_projection_provider_session_bindings
            WHERE thread_id IN (SELECT thread_id FROM kept_threads)
          )`;
      for (const { name } of threadTables) {
        yield* sql.unsafe(
          `DELETE FROM "${name}" WHERE thread_id NOT IN (SELECT thread_id FROM kept_threads)`,
        ).unprepared;
      }
      yield* sql`DELETE FROM orchestration_v2_projection_context_transfers
        WHERE source_thread_id NOT IN (SELECT thread_id FROM kept_threads)
           OR target_thread_id NOT IN (SELECT thread_id FROM kept_threads)`;
      yield* sql`DELETE FROM orchestration_events
        WHERE (aggregate_kind = 'thread'
            AND stream_id NOT IN (SELECT thread_id FROM kept_threads))
           OR (aggregate_kind = 'project'
            AND stream_id NOT IN (SELECT project_id FROM kept_projects))`;
      for (const table of CLEARED_TABLES) {
        yield* sql`DELETE FROM ${sql(table)}`;
      }
    }),
  );

  const keptProjects = yield* sql<{ title: string; threads: number }>`
    SELECT
      p.title,
      (SELECT COUNT(*) FROM orchestration_v2_projection_threads t
        WHERE t.project_id = p.project_id) AS threads
    FROM projection_projects p
    ORDER BY p.updated_at DESC`;
  const [events] = yield* sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_events`;

  return {
    projects: keptProjects as ReadonlyArray<KeptProject>,
    eventCount: events?.count ?? 0,
  };
});

const verifyMigrationSlots = Effect.fn("verifyMigrationSlots")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const applied = yield* sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations`;
  const appliedById = new Map(applied.map((row) => [Number(row.migration_id), row.name]));
  for (const [slot, codeName] of migrationManifest) {
    const appliedName = appliedById.get(slot);
    if (appliedName !== undefined && appliedName !== codeName) {
      return yield* new MigrateDevDbSlotCollisionError({ slot, codeName, appliedName });
    }
  }
});

export const runMigrateDevDb = Effect.fn("runMigrateDevDb")(function* (
  input: RunMigrateDevDbInput,
  options: RunMigrateDevDbOptions = {},
) {
  if (input.projects < 1 || input.threadsPerProject < 0) {
    return yield* Effect.die("projects must be >= 1 and threadsPerProject >= 0");
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const sharedHome = path.resolve(options.sharedHome ?? path.join(NodeOS.homedir(), ".t3"));
  const defaultSourcePath = path.join(sharedHome, "userdata", "statev2.sqlite");
  const resolvedSourcePath = path.resolve(input.source ?? defaultSourcePath);
  const sourcePath = yield* fs
    .realPath(resolvedSourcePath)
    .pipe(Effect.orElseSucceed(() => resolvedSourcePath));
  const canonicalDefaultSourcePath = yield* fs
    .realPath(defaultSourcePath)
    .pipe(Effect.orElseSucceed(() => defaultSourcePath));

  const baseDir =
    input.baseDir !== undefined
      ? path.resolve(input.baseDir)
      : yield* resolveWorktreeT3Home(process.cwd());
  if (baseDir === undefined) {
    return yield* new MigrateDevDbNotInWorktreeError();
  }
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  const snapshotPath = `${databasePath}.migrate-dev-db-tmp`;

  if (!(yield* fs.exists(sourcePath))) {
    return yield* new MigrateDevDbSourceMissingError({ sourcePath });
  }
  const [canonicalBaseDir, canonicalSharedHome] = yield* Effect.all([
    fs.realPath(baseDir).pipe(Effect.orElseSucceed(() => baseDir)),
    fs.realPath(sharedHome).pipe(Effect.orElseSucceed(() => sharedHome)),
  ]);
  if (canonicalBaseDir === canonicalSharedHome) {
    return yield* new MigrateDevDbSharedHomeError();
  }
  for (const destination of [databasePath, snapshotPath]) {
    const canonicalDestination = yield* fs
      .realPath(destination)
      .pipe(Effect.orElseSucceed(() => destination));
    if (sourcePath === canonicalDestination) {
      return yield* new MigrateDevDbSourceIsDestinationError({ sourcePath });
    }
  }

  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* ensureNotInUse(databasePath);

  const wrapPhase =
    (phase: MigrateDevDbPhaseError["phase"], phaseDatabasePath: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new MigrateDevDbPhaseError({ phase, databasePath: phaseDatabasePath, cause }),
        ),
      );

  yield* removeDatabaseFiles(snapshotPath);
  const { executedMigrations, pruned } = yield* Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const livePid = yield* liveDevDbServerPid(sourcePath);
        const copyPath =
          sourcePath === canonicalDefaultSourcePath || livePid !== undefined
            ? yield* snapshotDevDb(sourcePath).pipe(
                Effect.catchTags({
                  DevDbSnapshotError: Effect.fn("fallbackDevDbSource")(function* (error) {
                    if (
                      livePid !== undefined ||
                      (yield* liveDevDbServerPid(sourcePath)) !== undefined
                    ) {
                      return yield* error;
                    }
                    yield* Console.log(
                      "Source is not owned by a live server; reading it directly.",
                    );
                    return sourcePath;
                  }),
                }),
              )
            : sourcePath;
        yield* Console.log(`Copying visible threads from ${copyPath} (read-only)...`);
        yield* copySourceSlice(copyPath).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
          wrapPhase("snapshot", copyPath),
        );
      }),
    );

    yield* Console.log("Running migrations on the snapshot...");
    const executed = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("PRAGMA foreign_keys = ON").unprepared;
      return yield* runMigrations();
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      wrapPhase("migrate", snapshotPath),
    );

    yield* verifyMigrationSlots().pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(
            new MigrateDevDbPhaseError({ phase: "verify", databasePath: snapshotPath, cause }),
          ),
      }),
    );

    yield* Console.log(
      `Pruning to ${input.projects} projects, ${input.threadsPerProject} stopped threads each...`,
    );
    const result = yield* pruneSnapshot(input).pipe(
      Effect.provide(
        ProjectionStore.layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: snapshotPath })),
        ),
      ),
      wrapPhase("prune", snapshotPath),
    );

    yield* Console.log(`Compacting into ${databasePath}...`);
    yield* ensureNotInUse(databasePath);
    yield* removeDatabaseFiles(databasePath);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${databasePath}`;
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      wrapPhase("compact", databasePath),
    );
    return { executedMigrations: executed, pruned: result };
  }).pipe(Effect.ensuring(removeDatabaseFiles(snapshotPath)));
  yield* fs.chmod(databasePath, 0o600);

  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
    wrapPhase("compact", databasePath),
  );

  const size = (yield* fs.stat(databasePath)).size;
  return {
    databasePath,
    sizeBytes: Number(size),
    projects: pruned.projects,
    eventCount: pruned.eventCount,
    executedMigrations: executedMigrations.map(([id, name]) => `${id}_${name}`),
  };
});

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;

export const migrateDevDbCommand = Command.make(
  "migrate-dev-db",
  {
    projects: Flag.Int("projects").pipe(
      Flag.withDefault(5),
      Flag.withDescription("How many recently updated projects to keep."),
    ),
    threadsPerProject: Flag.Int("threads-per-project").pipe(
      Flag.withDefault(10),
      Flag.withDescription(
        "How many recent stopped threads, with their forks and subagents, to keep per project. A family with more threads than this is skipped.",
      ),
    ),
    baseDir: Flag.String("base-dir").pipe(
      Flag.optional,
      Flag.withDescription("Isolated .t3 directory. Defaults to the current worktree's .t3."),
    ),
    source: Flag.String("source").pipe(
      Flag.optional,
      Flag.withDescription("Source database. Defaults to ~/.t3/userdata/statev2.sqlite."),
    ),
  },
  ({ projects, threadsPerProject, baseDir, source }) =>
    Effect.gen(function* () {
      const result = yield* runMigrateDevDb({
        projects,
        threadsPerProject,
        baseDir: Option.getOrUndefined(baseDir),
        source: Option.getOrUndefined(source),
      });
      yield* Console.log("");
      yield* Console.log(
        `Dev database ready: ${result.databasePath} (${formatSize(result.sizeBytes)})`,
      );
      for (const project of result.projects) {
        yield* Console.log(`  ${project.title}: ${project.threads} threads`);
      }
      yield* Console.log(`  ${result.eventCount} orchestration events kept`);
      yield* Console.log(
        result.executedMigrations.length === 0
          ? "  Migrations: already current (no new migrations in this checkout)"
          : `  Migrations applied: ${result.executedMigrations.join(", ")}`,
      );
    }),
).pipe(
  Command.withDescription(
    "Rebuild the worktree dev database from a pruned snapshot of the real ~/.t3 data, then run migrations.",
  ),
);

if (import.meta.main) {
  Command.run(migrateDevDbCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
