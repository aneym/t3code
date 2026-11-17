import {
  SERVER_RUNS_MAX_IDS,
  SERVER_SNAPSHOT_MAX_SECONDS,
  ServerDatabaseInfo,
  ServerDatabaseSnapshotManifest,
  ServerRunsListResult,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import {
  McpServerNotRunningError,
  McpServerUnreachableError,
  McpToolFailedError,
  printJson,
  reportCliErrors,
  withOwnerMcpTools,
} from "./ownerMcpTools.ts";

export class ServerDatabaseUsageError extends Schema.TaggedError<ServerDatabaseUsageError>()(
  "ServerDatabaseUsageError",
  { detail: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

const reportErrors = reportCliErrors(
  Schema.is(
    Schema.Union([
      McpServerNotRunningError,
      McpServerUnreachableError,
      McpToolFailedError,
      ServerDatabaseUsageError,
    ]),
  ),
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON."),
  Flag.withDefault(false),
);

const runsListCommand = Command.make("list", {
  ...projectLocationFlags,
  open: Flag.Boolean("open").pipe(
    Flag.withDescription(
      "Every queued, preparing, starting, running or waiting run, in all projects, subagents included.",
    ),
    Flag.withDefault(false),
  ),
  ids: Flag.String("ids").pipe(
    Flag.withDescription("Only the runs with these comma-separated ids."),
    Flag.optional,
  ),
  thread: Flag.String("thread").pipe(
    Flag.withDescription("Every run of this thread."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List runs from the running server's database."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const ids = Option.map(flags.ids, (text) =>
        text
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      );
      const selectors = [flags.open, Option.isSome(ids), Option.isSome(flags.thread)];
      if (selectors.filter(Boolean).length !== 1) {
        return yield* new ServerDatabaseUsageError({
          detail: "Pass exactly one of --open, --ids or --thread.",
        });
      }
      if (
        Option.isSome(ids) &&
        (ids.value.length === 0 || ids.value.length > SERVER_RUNS_MAX_IDS)
      ) {
        return yield* new ServerDatabaseUsageError({
          detail: `--ids takes 1 to ${SERVER_RUNS_MAX_IDS} run ids.`,
        });
      }
      yield* withOwnerMcpTools(
        "runs",
        flags,
        Effect.fn("cli.runs.list")(function* (tools) {
          const { runs } = yield* tools.call(
            "t3_runs_list",
            flags.open
              ? { open: true }
              : Option.isSome(ids)
                ? { runIds: ids.value }
                : { threadId: Option.getOrElse(flags.thread, () => "") },
            ServerRunsListResult,
          );
          if (flags.json) return yield* printJson(runs);
          for (const run of runs) {
            const waiting =
              run.waitingOn.length > 0 ? `  waiting on ${run.waitingOn.join(",")}` : "";
            yield* Console.log(
              `${run.threadId}  ${run.runId}  ${run.status.padEnd(10)}  ${run.title ?? ""}${waiting}`,
            );
          }
        }),
      );
    }).pipe(reportErrors),
  ),
);

export const runsCommand = Command.make("runs").pipe(
  Command.withDescription("Read runs from the running server."),
  Command.withSubcommands([runsListCommand]),
);

const dbInfoCommand = Command.make("info", { ...projectLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription(
    "Show the running server database's migrations, identity and size, read by the server.",
  ),
  Command.withHandler((flags) =>
    withOwnerMcpTools(
      "db",
      flags,
      Effect.fn("cli.db.info")(function* (tools) {
        const info = yield* tools.call("t3_db_info", {}, ServerDatabaseInfo);
        if (flags.json) return yield* printJson(info);
        const last = info.migrations.at(-1);
        const lastFork = info.forkMigrations.at(-1);
        yield* Console.log(
          `migrations       ${info.migrations.length} (last ${last?.id ?? "-"} ${last?.name ?? ""})`,
        );
        yield* Console.log(
          `fork migrations  ${info.forkMigrations.length} (last ${lastFork?.id ?? "-"} ${lastFork?.name ?? ""})`,
        );
        yield* Console.log(`threads          ${info.threadCount}`);
        yield* Console.log(`messages         ${info.messageCount}`);
        yield* Console.log(`events max rowid ${info.eventsMaxRowid ?? "-"}`);
        yield* Console.log(`pages            ${info.pageCount} x ${info.pageSize}`);
        yield* Console.log(`database bytes   ${info.databaseBytes}`);
        yield* Console.log(`wal bytes        ${info.walBytes}`);
      }),
    ).pipe(reportErrors),
  ),
);

const dbSnapshotCommand = Command.make("snapshot", {
  ...projectLocationFlags,
  destination: Argument.String("destination").pipe(
    Argument.withDescription(
      "New file for the copy, outside the server's data. Its manifest goes beside it as <destination>.json.",
    ),
  ),
  keysOnly: Flag.Boolean("keys-only").pipe(
    Flag.withDescription("Copy only the thread and message ids, not the whole database."),
    Flag.withDefault(false),
  ),
  maxSeconds: Flag.Int("max-seconds").pipe(
    Flag.withSchema(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SERVER_SNAPSHOT_MAX_SECONDS })),
    ),
    Flag.withDescription("Give up after this many seconds. Default 1200."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Have the running server write a consistent copy of its database. The copy holds every secret the database does.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const destination = path.resolve(flags.destination);
      yield* withOwnerMcpTools(
        "db",
        flags,
        Effect.fn("cli.db.snapshot")(function* (tools) {
          const manifest = yield* tools.call(
            "t3_db_snapshot",
            {
              destination,
              ...(flags.keysOnly ? { keysOnly: true } : {}),
              ...Option.match(flags.maxSeconds, {
                onNone: () => ({}),
                onSome: (maxSeconds) => ({ maxSeconds }),
              }),
            },
            ServerDatabaseSnapshotManifest,
          );
          if (flags.json) return yield* printJson(manifest);
          yield* Console.log(
            `${manifest.path}  ${manifest.method}  ${manifest.bytes} bytes  pinned ${manifest.pinnedSeconds.toFixed(2)} s`,
          );
        }),
      );
    }).pipe(reportErrors),
  ),
);

export const dbCommand = Command.make("db").pipe(
  Command.withDescription("Read the running server's database through the server."),
  Command.withSubcommands([dbInfoCommand, dbSnapshotCommand]),
);
