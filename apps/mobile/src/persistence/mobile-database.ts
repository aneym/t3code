import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type { SQLiteDatabase } from "expo-sqlite";

import {
  enforceThreadCacheBudget,
  THREAD_CACHE_MAX_BYTES,
  type ThreadCacheBudgetInput,
  type ThreadCacheIndexRow,
} from "./thread-cache-budget";

const DATABASE_NAME = "t3code-client.db";
const DATABASE_SCHEMA_VERSION = 2;
const LEGACY_CACHE_DIRECTORIES = [
  "connection-shell-snapshots",
  "shell-snapshots",
  "connection-thread-snapshots",
  "connection-server-configs",
  "connection-vcs-refs",
] as const;

export const ClientCacheKind = Schema.Literals([
  "shell",
  "thread",
  "server-config",
  "vcs-refs",
  "project-favicon",
  "pull-request",
]);
export type ClientCacheKind = typeof ClientCacheKind.Type;

export interface ClientCacheSummaryRow {
  readonly environmentId: EnvironmentId;
  readonly kind: ClientCacheKind;
  readonly recordCount: number;
  readonly payloadBytes: number;
}

export interface StoredPreferencesJson {
  readonly payload: string;
  readonly updatedAt: number;
}

const ClientCacheSummaryRows = Schema.Array(
  Schema.Struct({
    environmentId: Schema.String,
    kind: ClientCacheKind,
    recordCount: Schema.Number,
    payloadBytes: Schema.Number,
  }),
);

const MobileDatabaseOperation = Schema.Literals([
  "open",
  "migrate",
  "load-cache",
  "list-cache",
  "list-thread-cache-index",
  "enforce-thread-cache-budget",
  "save-cache",
  "remove-cache",
  "clear-cache-kind",
  "clear-environment-cache",
  "clear-all-caches",
  "inspect-caches",
  "load-preferences",
  "save-preferences",
]);

export class MobileDatabaseError extends Schema.TaggedError<MobileDatabaseError>()(
  "MobileDatabaseError",
  {
    operation: MobileDatabaseOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Mobile database operation failed: ${this.operation}.`;
  }
}

function databaseError(operation: typeof MobileDatabaseOperation.Type) {
  return (cause: unknown) => new MobileDatabaseError({ operation, cause });
}

interface LegacyCacheRecord {
  readonly environmentId: string;
  readonly kind: ClientCacheKind;
  readonly cacheKey: string;
  readonly schemaVersion: number;
  readonly payload: string;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function decodeLegacyCacheRecord(
  directoryName: (typeof LEGACY_CACHE_DIRECTORIES)[number],
  payload: string,
): LegacyCacheRecord | null {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = objectRecord(JSON.parse(payload));
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed.environmentId !== "string" ||
    typeof parsed.schemaVersion !== "number"
  ) {
    return null;
  }

  switch (directoryName) {
    case "connection-shell-snapshots":
    case "shell-snapshots":
      return {
        environmentId: parsed.environmentId,
        kind: "shell",
        cacheKey: "snapshot",
        schemaVersion: parsed.schemaVersion,
        payload,
      };
    case "connection-thread-snapshots":
      return typeof parsed.threadId === "string"
        ? {
            environmentId: parsed.environmentId,
            kind: "thread",
            cacheKey: parsed.threadId,
            schemaVersion: parsed.schemaVersion,
            payload,
          }
        : null;
    case "connection-server-configs":
      return {
        environmentId: parsed.environmentId,
        kind: "server-config",
        cacheKey: "config",
        schemaVersion: parsed.schemaVersion,
        payload,
      };
    case "connection-vcs-refs":
      return typeof parsed.cwd === "string"
        ? {
            environmentId: parsed.environmentId,
            kind: "vcs-refs",
            cacheKey: parsed.cwd,
            schemaVersion: parsed.schemaVersion,
            payload,
          }
        : null;
  }
}

async function migrateLegacyFileCaches(database: SQLiteDatabase): Promise<boolean> {
  try {
    const { Directory, File, Paths } = await import("expo-file-system");
    let complete = true;
    const listFiles = (
      directory: InstanceType<typeof Directory>,
    ): Array<InstanceType<typeof File>> =>
      directory.list().flatMap((entry) => (entry instanceof File ? [entry] : listFiles(entry)));

    for (const directoryName of LEGACY_CACHE_DIRECTORIES) {
      try {
        const directory = new Directory(Paths.document, directoryName);
        if (!directory.exists) continue;
        for (const file of listFiles(directory)) {
          const payload = await file.text();
          const record = decodeLegacyCacheRecord(directoryName, payload);
          if (record === null) continue;
          await database.withExclusiveTransactionAsync(async (transaction) => {
            await transaction.runAsync(
              `INSERT INTO client_cache
                (environment_id, kind, cache_key, schema_version, payload, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (environment_id, kind, cache_key) DO NOTHING`,
              record.environmentId,
              record.kind,
              record.cacheKey,
              record.schemaVersion,
              record.payload,
              Date.now(),
            );
            await transaction.runAsync(
              `INSERT OR IGNORE INTO client_cache_meta
                (environment_id, kind, cache_key, byte_size, accessed_at, source_updated_at)
               VALUES (?, ?, ?, ?, ?, NULL)`,
              record.environmentId,
              record.kind,
              record.cacheKey,
              new TextEncoder().encode(record.payload).length,
              Date.now(),
            );
          });
        }
        directory.delete();
      } catch (cause) {
        complete = false;
        console.warn(`[mobile-database] could not migrate legacy cache ${directoryName}`, cause);
      }
    }
    return complete;
  } catch (cause) {
    console.warn("[mobile-database] could not load legacy cache migration", cause);
    return false;
  }
}

export class MobileDatabase extends Context.Service<
  MobileDatabase,
  {
    readonly loadCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
    ) => Effect.Effect<Option.Option<string>, MobileDatabaseError>;
    readonly listCache: (
      kind: ClientCacheKind,
    ) => Effect.Effect<ReadonlyArray<string>, MobileDatabaseError>;
    readonly saveCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
      schemaVersion: number,
      payload: string,
      sourceUpdatedAt?: number | null,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly listThreadCacheIndex: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ReadonlyArray<ThreadCacheIndexRow>, MobileDatabaseError>;
    readonly enforceThreadCacheBudget: (
      input: ThreadCacheBudgetInput,
    ) => Effect.Effect<{ evicted: number; bytes: number }, MobileDatabaseError>;
    readonly setThreadCacheProtection: (input: {
      readonly loaded: boolean;
      readonly protectedThreadKeys: ReadonlySet<string>;
    }) => Effect.Effect<void, MobileDatabaseError>;
    readonly removeCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly clearCacheKind: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly clearEnvironmentCache: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly clearAllCaches: Effect.Effect<void, MobileDatabaseError>;
    readonly inspectCaches: Effect.Effect<
      ReadonlyArray<ClientCacheSummaryRow>,
      MobileDatabaseError
    >;
    readonly loadPreferencesJson: Effect.Effect<
      Option.Option<StoredPreferencesJson>,
      MobileDatabaseError
    >;
    readonly savePreferencesJson: (
      payload: string,
      updatedAt: number,
    ) => Effect.Effect<void, MobileDatabaseError>;
  }
>()("@t3tools/mobile/persistence/MobileDatabase") {}

const makeAvailable = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const SQLite = await import("expo-sqlite");
        return SQLite.openDatabaseAsync(DATABASE_NAME);
      },
      catch: databaseError("open"),
    }),
    (openDatabase) => Effect.promise(() => openDatabase.closeAsync()).pipe(Effect.ignore),
  );

  yield* Effect.tryPromise({
    try: async () => {
      await database.execAsync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      await database.withExclusiveTransactionAsync(async (transaction) => {
        await transaction.execAsync(`
              CREATE TABLE IF NOT EXISTS client_cache (
                environment_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                cache_key TEXT NOT NULL,
                schema_version INTEGER NOT NULL,
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (environment_id, kind, cache_key)
              ) WITHOUT ROWID;

              CREATE INDEX IF NOT EXISTS client_cache_environment_updated
                ON client_cache (environment_id, updated_at DESC);

              CREATE TABLE IF NOT EXISTS client_cache_meta (
                environment_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                cache_key TEXT NOT NULL,
                byte_size INTEGER NOT NULL,
                accessed_at INTEGER NOT NULL,
                source_updated_at INTEGER,
                PRIMARY KEY (environment_id, kind, cache_key),
                FOREIGN KEY (environment_id, kind, cache_key)
                  REFERENCES client_cache(environment_id, kind, cache_key) ON DELETE CASCADE
              ) WITHOUT ROWID;
              CREATE INDEX IF NOT EXISTS client_cache_meta_thread_accessed
                ON client_cache_meta (accessed_at, environment_id, cache_key) WHERE kind = 'thread';

              CREATE TABLE IF NOT EXISTS client_preferences (
                singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL
              );
            `);
      });
      const schema = await database.getFirstAsync<{ readonly user_version: number }>(
        "PRAGMA user_version",
      );
      if ((schema?.user_version ?? 0) < DATABASE_SCHEMA_VERSION) {
        await database.runAsync(
          `INSERT OR IGNORE INTO client_cache_meta
             (environment_id, kind, cache_key, byte_size, accessed_at, source_updated_at)
           SELECT environment_id, kind, cache_key, LENGTH(CAST(payload AS BLOB)), updated_at, NULL
           FROM client_cache`,
        );
        const migrated = await migrateLegacyFileCaches(database);
        if (migrated) {
          await database.execAsync(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};`);
        }
      }
    },
    catch: databaseError("migrate"),
  });

  const budgetRequests = yield* Queue.sliding<void>(1);
  let budgetOutboxLoaded = false;
  const budgetProtectedThreadKeys = new Set<string>();
  yield* Effect.gen(function* () {
    while (true) {
      yield* Queue.take(budgetRequests);
      yield* Effect.sleep("30 seconds");
      while ((yield* Queue.poll(budgetRequests))._tag === "Some") {}
      yield* Effect.tryPromise({
        try: () =>
          budgetOutboxLoaded
            ? enforceThreadCacheBudget(database, {
                maxBytes: THREAD_CACHE_MAX_BYTES,
                protectedThreadKeys: budgetProtectedThreadKeys,
              })
            : Promise.resolve({ evicted: 0, bytes: 0 }),
        catch: databaseError("enforce-thread-cache-budget"),
      }).pipe(Effect.catch((error) => Effect.logWarning(error)));
    }
  }).pipe(Effect.forkScoped);

  return MobileDatabase.of({
    loadCache: Effect.fn("MobileDatabase.loadCache")((environmentId, kind, cacheKey) =>
      Effect.tryPromise({
        try: async () => {
          const now = Date.now();
          const row = await database.getFirstAsync<{
            readonly payload: string;
            readonly accessedAt: number;
          }>(
            `SELECT client_cache.payload, client_cache_meta.accessed_at AS accessedAt
                     FROM client_cache
                     JOIN client_cache_meta USING (environment_id, kind, cache_key)
                     WHERE client_cache.environment_id = ? AND client_cache.kind = ? AND client_cache.cache_key = ?
                       AND (client_cache.kind != 'pull-request' OR client_cache.updated_at >= ?)`,
            environmentId,
            kind,
            cacheKey,
            now - 30 * 24 * 60 * 60_000,
          );
          if (kind === "thread" && row && row.accessedAt <= now - 60_000) {
            await database.runAsync(
              `UPDATE client_cache_meta SET accessed_at = ?
               WHERE environment_id = ? AND kind = 'thread' AND cache_key = ? AND accessed_at <= ?`,
              now,
              environmentId,
              cacheKey,
              now - 60_000,
            );
          }
          return row;
        },
        catch: databaseError("load-cache"),
      }).pipe(Effect.map((row) => Option.fromNullishOr(row?.payload))),
    ),
    listCache: Effect.fn("MobileDatabase.listCache")((kind) =>
      Effect.tryPromise({
        try: () =>
          database.getAllAsync<{ readonly payload: string }>(
            "SELECT payload FROM client_cache WHERE kind = ? ORDER BY updated_at",
            kind,
          ),
        catch: databaseError("list-cache"),
      }).pipe(Effect.map((rows) => rows.map((row) => row.payload))),
    ),
    listThreadCacheIndex: Effect.fn("MobileDatabase.listThreadCacheIndex")((environmentId) =>
      Effect.tryPromise({
        try: () =>
          database.getAllAsync<ThreadCacheIndexRow>(
            `SELECT cache_key AS threadId, source_updated_at AS sourceUpdatedAt,
             byte_size AS bytes, accessed_at AS accessedAt
           FROM client_cache_meta WHERE environment_id = ? AND kind = 'thread'`,
            environmentId,
          ),
        catch: databaseError("list-thread-cache-index"),
      }),
    ),
    enforceThreadCacheBudget: Effect.fn("MobileDatabase.enforceThreadCacheBudget")((input) =>
      Effect.tryPromise({
        try: () => enforceThreadCacheBudget(database, input),
        catch: databaseError("enforce-thread-cache-budget"),
      }),
    ),
    setThreadCacheProtection: Effect.fn("MobileDatabase.setThreadCacheProtection")((input) =>
      Effect.sync(() => {
        budgetOutboxLoaded = input.loaded;
        budgetProtectedThreadKeys.clear();
        for (const key of input.protectedThreadKeys) budgetProtectedThreadKeys.add(key);
      }),
    ),
    saveCache: Effect.fn("MobileDatabase.saveCache")(
      (environmentId, kind, cacheKey, schemaVersion, payload, sourceUpdatedAt) =>
        Effect.tryPromise({
          try: async () => {
            if (
              kind === "pull-request" &&
              new TextEncoder().encode(payload).length > 4 * 1024 * 1024
            )
              return;
            const save = async (transaction: SQLiteDatabase) => {
              await transaction.runAsync(
                `INSERT INTO client_cache
                  (environment_id, kind, cache_key, schema_version, payload, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (environment_id, kind, cache_key) DO UPDATE SET
                   schema_version = excluded.schema_version,
                   payload = excluded.payload,
                   updated_at = excluded.updated_at`,
                environmentId,
                kind,
                cacheKey,
                schemaVersion,
                payload,
                Date.now(),
              );
              await transaction.runAsync(
                `INSERT INTO client_cache_meta
                  (environment_id, kind, cache_key, byte_size, accessed_at, source_updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (environment_id, kind, cache_key) DO UPDATE SET
                   byte_size = excluded.byte_size,
                   accessed_at = excluded.accessed_at,
                   source_updated_at = excluded.source_updated_at`,
                environmentId,
                kind,
                cacheKey,
                new TextEncoder().encode(payload).length,
                Date.now(),
                kind === "thread" ? (sourceUpdatedAt ?? null) : null,
              );
              if (kind === "pull-request") {
                await transaction.runAsync(
                  `DELETE FROM client_cache WHERE environment_id = ? AND kind = 'pull-request'
                   AND cache_key IN (
                     SELECT cache_key FROM (
                       SELECT cache_key, updated_at,
                         ROW_NUMBER() OVER (ORDER BY updated_at DESC, cache_key) AS position,
                         SUM(LENGTH(CAST(payload AS BLOB))) OVER (
                           ORDER BY updated_at DESC, cache_key
                         ) AS total_bytes
                       FROM client_cache WHERE environment_id = ? AND kind = 'pull-request'
                     ) WHERE position > 256 OR total_bytes > 33554432 OR updated_at < ?
                   )`,
                  environmentId,
                  environmentId,
                  Date.now() - 30 * 24 * 60 * 60_000,
                );
              }
            };
            await database.withExclusiveTransactionAsync(save);
          },
          catch: databaseError("save-cache"),
        }).pipe(
          Effect.andThen(() =>
            kind === "thread" ? Queue.offer(budgetRequests, undefined) : Effect.void,
          ),
          Effect.asVoid,
        ),
    ),
    removeCache: Effect.fn("MobileDatabase.removeCache")((environmentId, kind, cacheKey) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            `DELETE FROM client_cache
                     WHERE environment_id = ? AND kind = ? AND cache_key = ?`,
            environmentId,
            kind,
            cacheKey,
          ),
        catch: databaseError("remove-cache"),
      }).pipe(Effect.asVoid),
    ),
    clearCacheKind: Effect.fn("MobileDatabase.clearCacheKind")((environmentId, kind) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            "DELETE FROM client_cache WHERE environment_id = ? AND kind = ?",
            environmentId,
            kind,
          ),
        catch: databaseError("clear-cache-kind"),
      }).pipe(Effect.asVoid),
    ),
    clearEnvironmentCache: Effect.fn("MobileDatabase.clearEnvironmentCache")((environmentId) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync("DELETE FROM client_cache WHERE environment_id = ?", environmentId),
        catch: databaseError("clear-environment-cache"),
      }).pipe(Effect.asVoid),
    ),
    clearAllCaches: Effect.tryPromise({
      try: () => database.runAsync("DELETE FROM client_cache"),
      catch: databaseError("clear-all-caches"),
    }).pipe(Effect.asVoid),
    inspectCaches: Effect.tryPromise({
      try: () =>
        database.getAllAsync<unknown>(`
                SELECT
                  environment_id AS environmentId,
                  kind,
                  COUNT(*) AS recordCount,
                  COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS payloadBytes
                FROM client_cache
                GROUP BY environment_id, kind
                ORDER BY environment_id, kind
              `),
      catch: databaseError("inspect-caches"),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ClientCacheSummaryRows)),
      Effect.mapError(databaseError("inspect-caches")),
      Effect.map((rows): ReadonlyArray<ClientCacheSummaryRow> =>
        rows.map((row) => ({
          environmentId: row.environmentId as EnvironmentId,
          kind: row.kind,
          recordCount: row.recordCount,
          payloadBytes: row.payloadBytes,
        })),
      ),
    ),
    loadPreferencesJson: Effect.tryPromise({
      try: () =>
        database.getFirstAsync<StoredPreferencesJson>(
          `SELECT payload, updated_at AS updatedAt
                 FROM client_preferences
                 WHERE singleton = 1`,
        ),
      catch: databaseError("load-preferences"),
    }).pipe(Effect.map(Option.fromNullishOr)),
    savePreferencesJson: Effect.fn("MobileDatabase.savePreferencesJson")((payload, updatedAt) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            `INSERT INTO client_preferences (singleton, payload, updated_at)
                   VALUES (1, ?, ?)
                   ON CONFLICT (singleton) DO UPDATE SET
                     payload = excluded.payload,
                     updated_at = excluded.updated_at`,
            payload,
            updatedAt,
          ),
        catch: databaseError("save-preferences"),
      }).pipe(Effect.asVoid),
    ),
  });
});

function makeUnavailable(error: MobileDatabaseError): MobileDatabase["Service"] {
  const fail = Effect.fail(error);
  return MobileDatabase.of({
    loadCache: () => fail,
    listCache: () => fail,
    listThreadCacheIndex: () => fail,
    enforceThreadCacheBudget: () => fail,
    setThreadCacheProtection: () => fail,
    saveCache: () => fail,
    removeCache: () => fail,
    clearCacheKind: () => fail,
    clearEnvironmentCache: () => fail,
    clearAllCaches: fail,
    inspectCaches: fail,
    loadPreferencesJson: fail,
    savePreferencesJson: () => fail,
  });
}

export const make = Effect.result(makeAvailable).pipe(
  Effect.map((result) =>
    result._tag === "Success" ? result.success : makeUnavailable(result.failure),
  ),
);

export const layer = Layer.effect(MobileDatabase, make);
