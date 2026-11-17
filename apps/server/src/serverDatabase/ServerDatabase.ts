import * as NodeWorkerThreads from "node:worker_threads";

import {
  ServerDatabaseInfo,
  type ServerDatabaseSnapshotInput,
  ServerDatabaseSnapshotManifest,
  type ServerRunsListInput,
  ServerRunRow,
  type ServerRunsListResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { WAL_SIZE_LIMIT_BYTES } from "../persistence/Sqlite.ts";
import { stopRequested } from "../serverDrain/stopSignal.ts";
import { DATABASE_WORKER_SOURCE } from "./databaseWorkerSource.ts";

const OPEN_RUN_STATUSES = ["queued", "preparing", "starting", "running", "waiting"];
const IDENTITY_KEYS = [
  ["orchestration_v2_projection_threads", "thread_id"],
  ["orchestration_v2_projection_messages", "message_id"],
] as const;
const DEFAULT_MAX_SECONDS = 1200;
const WATCH_INTERVAL = Duration.millis(250);
const ABORT_GRACE = Duration.seconds(5);
const LOCK_WAIT_MS = 2000;
const CLONE_BUDGET_MS = 1500;
const STEP_PAGES = 4096;
const STEP_PAUSE_MS = 5;
const KEYS_BATCH = 5000;

export class ServerDatabaseError extends Schema.TaggedError<ServerDatabaseError>()(
  "ServerDatabaseError",
  {
    code: Schema.Literals([
      "busy",
      "wal_limit",
      "deadline",
      "stopping",
      "invalid_request",
      "orchestration_error",
    ]),
    message: Schema.String,
  },
) {}

const RunRecords = Schema.Array(
  Schema.Struct({
    ...ServerRunRow.fields,
    waitingOn: Schema.fromJsonString(Schema.Array(Schema.String)),
  }),
);
const decodeRunRecords = Schema.decodeUnknownEffect(RunRecords);
const decodeInfo = Schema.decodeUnknownEffect(ServerDatabaseInfo);
const manifestFields = ServerDatabaseSnapshotManifest.fields;
const CopiedSnapshot = Schema.Struct({
  method: manifestFields.method,
  bytes: manifestFields.bytes,
  keys: manifestFields.keys,
  pinnedSeconds: manifestFields.pinnedSeconds,
  expected: manifestFields.identity,
  history: manifestFields.migrations,
});
const decodeCopied = Schema.decodeUnknownEffect(CopiedSnapshot);
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(ServerDatabaseSnapshotManifest));

type WorkerTerminal =
  | { readonly type: "done"; readonly result: unknown }
  | { readonly type: "failed"; readonly reason: string; readonly message: string };

const failure = (code: ServerDatabaseError["code"], message: string) =>
  new ServerDatabaseError({ code, message });

const runWorker = (
  workerData: Record<string, unknown>,
  onPhase: (phase: string) => void,
  flag?: Int32Array,
) =>
  Effect.callback<WorkerTerminal>((resume) => {
    const worker = new NodeWorkerThreads.Worker(DATABASE_WORKER_SOURCE, { eval: true, workerData });
    const settle = (terminal: WorkerTerminal) => resume(Effect.succeed(terminal));
    worker.on("message", (message: WorkerTerminal | { readonly type: string }) => {
      if (message.type === "done" || message.type === "failed") settle(message as WorkerTerminal);
      else onPhase(message.type);
    });
    worker.on("error", (cause) =>
      settle({ type: "failed", reason: "error", message: cause.message }),
    );
    worker.on("exit", (code) =>
      settle({ type: "failed", reason: "error", message: `The database worker exited (${code}).` }),
    );
    return Effect.promise(() => {
      if (flag !== undefined) {
        Atomics.store(flag, 0, 1);
        Atomics.notify(flag, 0);
      }
      return worker.terminate();
    }).pipe(Effect.timeout(ABORT_GRACE), Effect.ignore);
  });

const cloneModeOf = (platform: NodeJS.Platform) =>
  platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;

export class ServerDatabase extends Context.Service<
  ServerDatabase,
  {
    readonly listRuns: (
      input: ServerRunsListInput,
    ) => Effect.Effect<ServerRunsListResult, ServerDatabaseError>;
    readonly info: Effect.Effect<ServerDatabaseInfo, ServerDatabaseError>;
    readonly snapshot: (
      input: ServerDatabaseSnapshotInput,
    ) => Effect.Effect<ServerDatabaseSnapshotManifest, ServerDatabaseError>;
  }
>()("t3/serverDatabase/ServerDatabase") {}

export const layer = Layer.effect(
  ServerDatabase,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { dbPath, stateDir } = yield* ServerConfig.ServerConfig;
    const cloneMode = cloneModeOf(yield* HostProcess.Platform);
    const walPath = `${dbPath}-wal`;
    let snapshotRunning = false;

    const walBytes = fs.stat(walPath).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );

    const present = (target: string) =>
      Effect.zipWith(
        fs.exists(target).pipe(Effect.orElseSucceed(() => false)),
        fs.readLink(target).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
        (exists, link) => exists || link,
      );

    const checkDestination = Effect.fn("ServerDatabase.checkDestination")(function* (
      destination: string,
    ) {
      if (!path.isAbsolute(destination)) {
        return yield* failure("invalid_request", "The snapshot destination must be absolute.");
      }
      const directory = yield* fs
        .realPath(path.dirname(destination))
        .pipe(
          Effect.mapError(() =>
            failure("invalid_request", `${path.dirname(destination)} does not exist.`),
          ),
        );
      const state = yield* fs.realPath(stateDir).pipe(Effect.orElseSucceed(() => stateDir));
      const relative = path.relative(state, directory);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        return yield* failure(
          "invalid_request",
          `The snapshot destination is inside ${state}, the server's own data.`,
        );
      }
      const target = path.join(directory, path.basename(destination));
      for (const taken of [target, `${target}.partial`, `${target}.json`]) {
        if (yield* present(taken)) {
          return yield* failure("invalid_request", `${taken} already exists.`);
        }
      }
      return target;
    });

    const listRuns = Effect.fn("ServerDatabase.listRuns")(function* (input: ServerRunsListInput) {
      const selectors = [
        input.open === true,
        input.runIds !== undefined,
        input.threadId !== undefined,
      ];
      if (selectors.filter(Boolean).length !== 1) {
        return yield* failure("invalid_request", "Pass exactly one of open, runIds or threadId.");
      }
      const filter =
        input.open === true
          ? sql`r.status IN ${sql.in(OPEN_RUN_STATUSES)}`
          : input.runIds !== undefined
            ? sql`r.run_id IN ${sql.in(input.runIds)}`
            : sql`r.thread_id = ${input.threadId ?? ""}`;
      const rows = yield* sql`
        SELECT
          r.thread_id AS "threadId",
          r.run_id AS "runId",
          r.ordinal AS "ordinal",
          r.status AS "status",
          t.title AS "title",
          json_extract(t.payload_json, '$.lineage.rootThreadId') AS "rootThreadId",
          r.requested_at AS "requestedAt",
          json_extract(r.payload_json, '$.startedAt') AS "startedAt",
          r.completed_at AS "completedAt",
          json_extract(r.payload_json, '$.restartContinuationOfRunId') AS "restartContinuationOfRunId",
          (
            SELECT json_group_array(DISTINCT i.type)
            FROM orchestration_v2_projection_turn_items i
            WHERE i.run_id = r.run_id AND i.status = 'waiting'
          ) AS "waitingOn"
        FROM orchestration_v2_projection_runs r
        LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
        WHERE ${filter}
        ORDER BY r.thread_id, r.ordinal
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => failure("orchestration_error", cause.message)),
      );
      const runs = yield* decodeRunRecords(rows).pipe(
        Effect.mapError((cause) => failure("orchestration_error", cause.message)),
      );
      return { runs };
    });

    const workerFailed = (terminal: Extract<WorkerTerminal, { type: "failed" }>) =>
      failure(
        terminal.reason === "busy" ? "busy" : "orchestration_error",
        terminal.reason === "error" ? terminal.message : `${terminal.reason}: ${terminal.message}`,
      );

    const info = Effect.gen(function* () {
      const terminal = yield* runWorker(
        { task: "info", live: dbPath, lockWaitMs: LOCK_WAIT_MS },
        () => {},
      );
      if (terminal.type === "failed") return yield* workerFailed(terminal);
      return yield* decodeInfo(terminal.result).pipe(
        Effect.mapError((cause) => failure("orchestration_error", cause.message)),
      );
    }).pipe(Effect.withSpan("ServerDatabase.info"));

    const removeCopy = (target: string) =>
      Effect.forEach(
        ["", "-wal", "-shm", "-journal"],
        (suffix) => fs.remove(`${target}${suffix}`, { force: true }).pipe(Effect.ignore),
        { discard: true },
      );

    const copy = Effect.fn("ServerDatabase.copy")(function* (
      destination: string,
      input: ServerDatabaseSnapshotInput,
    ) {
      const partial = `${destination}.partial`;
      const abort = new SharedArrayBuffer(4);
      const flag = new Int32Array(abort);
      const startedAt = yield* Clock.currentTimeMillis;
      const deadline = startedAt + (input.maxSeconds ?? DEFAULT_MAX_SECONDS) * 1000;
      const walAtStart = yield* walBytes;
      let walPeak = walAtStart;
      let pinned = false;
      let abortedFor: "wal_limit" | "deadline" | "stopping" | undefined;
      const worker = runWorker(
        {
          task: input.keysOnly === true ? "keys" : "snapshot",
          live: dbPath,
          partial,
          destination,
          clone: cloneMode,
          abort,
          lockWaitMs: LOCK_WAIT_MS,
          cloneBudgetMs: CLONE_BUDGET_MS,
          stepPages: STEP_PAGES,
          stepPauseMs: STEP_PAUSE_MS,
          tables: IDENTITY_KEYS,
          keysBatch: KEYS_BATCH,
        },
        (phase) => {
          pinned = phase === "pinned";
        },
        flag,
      );
      const watch = Effect.gen(function* () {
        while (abortedFor === undefined) {
          yield* Effect.sleep(WATCH_INTERVAL);
          const wal = yield* walBytes;
          walPeak = Math.max(walPeak, wal);
          const now = yield* Clock.currentTimeMillis;
          abortedFor =
            pinned && wal > WAL_SIZE_LIMIT_BYTES && wal > walAtStart
              ? "wal_limit"
              : now >= deadline
                ? "deadline"
                : stopRequested()
                  ? "stopping"
                  : undefined;
        }
        Atomics.store(flag, 0, 1);
        Atomics.notify(flag, 0);
        yield* Effect.sleep(ABORT_GRACE);
        return {
          type: "failed",
          reason: "aborted",
          message: "The database worker did not stop in time.",
        } satisfies WorkerTerminal;
      });
      const terminal = yield* Effect.raceFirst(worker, watch).pipe(
        Effect.onInterrupt(() => removeCopy(partial)),
      );
      if (terminal.type === "failed") {
        yield* removeCopy(partial);
        if (terminal.reason === "aborted" && abortedFor !== undefined) {
          const reasons = {
            wal_limit: `The server's WAL passed ${WAL_SIZE_LIMIT_BYTES} bytes while the snapshot held it.`,
            deadline: `The snapshot passed its ${input.maxSeconds ?? DEFAULT_MAX_SECONDS} s bound.`,
            stopping: "The server is stopping.",
          };
          return yield* failure(abortedFor, reasons[abortedFor]);
        }
        return yield* workerFailed(terminal);
      }
      const copied = yield* decodeCopied(terminal.result).pipe(
        Effect.mapError((cause) => failure("orchestration_error", cause.message)),
      );
      const { expected, history, ...rest } = copied;
      const manifest = {
        ...rest,
        path: destination,
        identity: expected,
        migrations: history,
        walPeakBytes: walPeak,
      };
      yield* fs
        .writeFileString(`${destination}.json`, `${encodeManifest(manifest)}\n`, {
          flag: "wx",
          mode: 0o600,
        })
        .pipe(Effect.mapError((cause) => failure("orchestration_error", cause.message)));
      return manifest;
    });

    const snapshot = Effect.fn("ServerDatabase.snapshot")(function* (
      input: ServerDatabaseSnapshotInput,
    ) {
      const destination = yield* checkDestination(input.destination);
      if (stopRequested()) return yield* failure("stopping", "The server is stopping.");
      if (snapshotRunning) return yield* failure("busy", "Another snapshot is running.");
      snapshotRunning = true;
      return yield* copy(destination, input).pipe(
        Effect.ensuring(Effect.sync(() => void (snapshotRunning = false))),
      );
    });

    return ServerDatabase.of({ listRuns, info, snapshot });
  }),
);
