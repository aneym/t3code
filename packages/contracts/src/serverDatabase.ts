import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

export const SERVER_RUNS_MAX_IDS = 500;
export const SERVER_SNAPSHOT_MAX_SECONDS = 3600;

export const ServerRunsListInput = Schema.Struct({
  open: Schema.optionalKey(Schema.Boolean),
  runIds: Schema.optionalKey(
    Schema.Array(Schema.String).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(SERVER_RUNS_MAX_IDS),
    ),
  ),
  threadId: Schema.optionalKey(Schema.String),
});
export type ServerRunsListInput = typeof ServerRunsListInput.Type;

export const ServerRunRow = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.String,
  ordinal: Schema.Int,
  status: Schema.String,
  title: Schema.NullOr(Schema.String),
  rootThreadId: Schema.NullOr(Schema.String),
  requestedAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  restartContinuationOfRunId: Schema.NullOr(Schema.String),
  waitingOn: Schema.Array(Schema.String),
});
export type ServerRunRow = typeof ServerRunRow.Type;

export const ServerRunsListResult = Schema.Struct({ runs: Schema.Array(ServerRunRow) });
export type ServerRunsListResult = typeof ServerRunsListResult.Type;

export const ServerMigrationRow = Schema.Struct({ id: Schema.Int, name: Schema.String });

export const ServerDatabaseIdentity = Schema.Struct({
  pageCount: NonNegativeInt,
  schemaObjects: NonNegativeInt,
  migrationRows: Schema.Record(Schema.String, NonNegativeInt),
  eventsMaxRowid: Schema.NullOr(NonNegativeInt),
});
export type ServerDatabaseIdentity = typeof ServerDatabaseIdentity.Type;

export const ServerDatabaseInfo = Schema.Struct({
  migrations: Schema.Array(ServerMigrationRow),
  forkMigrations: Schema.Array(ServerMigrationRow),
  schemaObjects: NonNegativeInt,
  pageCount: NonNegativeInt,
  pageSize: PositiveInt,
  freePageCount: NonNegativeInt,
  incrementalVacuumEnabled: Schema.Boolean,
  eventsMaxRowid: Schema.NullOr(NonNegativeInt),
  threadCount: NonNegativeInt,
  messageCount: NonNegativeInt,
  databaseBytes: NonNegativeInt,
  walBytes: NonNegativeInt,
});
export type ServerDatabaseInfo = typeof ServerDatabaseInfo.Type;

export const ServerDatabaseSnapshotInput = Schema.Struct({
  destination: Schema.String,
  keysOnly: Schema.optionalKey(Schema.Boolean),
  maxSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SERVER_SNAPSHOT_MAX_SECONDS })),
  ),
});
export type ServerDatabaseSnapshotInput = typeof ServerDatabaseSnapshotInput.Type;

export const ServerDatabaseSnapshotManifest = Schema.Struct({
  path: Schema.String,
  method: Schema.Literals(["clone", "backup", "keys"]),
  bytes: NonNegativeInt,
  identity: ServerDatabaseIdentity,
  migrations: Schema.Array(ServerMigrationRow),
  keys: Schema.optionalKey(Schema.Record(Schema.String, NonNegativeInt)),
  pinnedSeconds: Schema.Number,
  walPeakBytes: NonNegativeInt,
});
export type ServerDatabaseSnapshotManifest = typeof ServerDatabaseSnapshotManifest.Type;
