// @effect-diagnostics nodeBuiltinImport:off -- Warm preflight reads SQLite without opening application services.
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { migrationManifest } from "./persistence/Migrations.ts";
import { runServicePreflight } from "./cloud/servicePreflight.ts";
import { exchangeServiceMessage, hotSwapContext } from "./serviceChildTransport.ts";
import type * as ServerConfig from "./config.ts";

class ServiceWarmError extends Schema.TaggedError<ServiceWarmError>()("ServiceWarmError", {
  cause: Schema.Defect(),
}) {}

export const warmServiceChild = Effect.fn("serviceChildWarm.preflight")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const context = hotSwapContext();
  if (context === undefined || config.mode === "desktop") return false;
  const result = runServicePreflight({
    databasePath: config.dbPath,
    launcherProtocol: context.protocol,
  });
  if (result.status !== "ready") return yield* new ServiceWarmError({ cause: result.reason });
  yield* exchangeServiceMessage(
    {
      type: "ingress-ready",
      host: context.hotSwap?.publicHost ?? config.host ?? "127.0.0.1",
      port: context.hotSwap?.publicPort ?? config.port,
    },
    (reply) => reply.type === "ingress-bound",
  );
  const pending = context.update?.status === "pending" ? context.update : undefined;
  if (context.hotSwap?.warm && pending !== undefined) {
    const willMigrate = yield* Effect.try({
      try: () => {
        const db = new NodeSqlite.DatabaseSync(config.dbPath, { readOnly: true });
        try {
          const rows = db.prepare("SELECT migration_id, name FROM effect_sql_migrations").all();
          const recorded = new Map(rows.map((row) => [row.migration_id, row.name]));
          return migrationManifest.some(([id, name]) => recorded.get(id) !== name);
        } finally {
          db.close();
        }
      },
      catch: (cause) => new ServiceWarmError({ cause }),
    });
    yield* exchangeServiceMessage(
      { type: "warm", updateId: pending.id, willMigrate },
      (reply) => reply.type === "acquire" && reply.updateId === pending.id,
    );
  }
  return true;
});
