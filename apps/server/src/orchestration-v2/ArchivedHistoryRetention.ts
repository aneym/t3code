import {
  ArchivedHistoryTrimRun,
  CommandId,
  ThreadId,
  type ArchivedThreadsListInput,
  type ArchivedThreadsListResult,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import { plan, type PlannedThread } from "./ArchivedHistoryPlan.ts";
import { PAGE_BYTES, PAGE_ROWS, budgetSpent, makeThreadTrimmer } from "./ArchivedHistoryTrim.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const PLAN_PAGE = 100;
const PASS_MAX_BYTES = 4 * 1024 ** 3;
const PASS_MAX_MS = 30 * 60_000;

export class ArchivedHistoryRetentionError extends Schema.TaggedError<ArchivedHistoryRetentionError>()(
  "ArchivedHistoryRetentionError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export class ArchivedHistoryRetention extends Context.Service<
  ArchivedHistoryRetention,
  {
    readonly list: (
      input: ArchivedThreadsListInput,
    ) => Effect.Effect<ArchivedThreadsListResult, ArchivedHistoryRetentionError>;
    readonly runPass: (
      betweenPages: Effect.Effect<void>,
    ) => Effect.Effect<ArchivedHistoryTrimRun | null>;
    readonly passRequests: Stream.Stream<void>;
  }
>()("t3/orchestration-v2/ArchivedHistoryRetention") {}

const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(ArchivedHistoryTrimRun));
const encodeRun = Schema.encodeEffect(Schema.fromJsonString(ArchivedHistoryTrimRun));

const decodeCursor = (cursor: string) => {
  const split = cursor.indexOf("|");
  return split <= 0
    ? undefined
    : { archivedAt: cursor.slice(0, split), threadId: cursor.slice(split + 1) };
};

const percentile = (values: ReadonlyArray<number>, fraction: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settingsService = yield* Settings.ServerSettingsService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const context = yield* Effect.context<SqlClient.SqlClient | ProjectionStore.ProjectionStoreV2>();
  const trimmer = yield* makeThreadTrimmer;
  const runPath = path.join(path.dirname(config.dbPath), "archived-history-trim.json");

  const readLastRun = fs.readFileString(runPath).pipe(
    Effect.flatMap(decodeRun),
    Effect.orElseSucceed(() => null),
  );

  const readDatabase = Effect.gen(function* () {
    const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
    const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
    const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    const pageSize = size[0]?.page_size ?? 0;
    return {
      bytes: (pages[0]?.page_count ?? 0) * pageSize,
      freeBytes: (free[0]?.freelist_count ?? 0) * pageSize,
      incrementalVacuum: mode[0]?.auto_vacuum === 2,
    };
  }).pipe(NodeSqliteClient.readOnly);

  const list = Effect.fn("ArchivedHistoryRetention.list")(
    function* (input: ArchivedThreadsListInput) {
      const settings = yield* settingsService.getSettings;
      const retentionDays = settings.storageCleanup.archivedHistoryAfterDays;
      const evaluatedDays = input.olderThanDays ?? retentionDays;
      const after =
        input.cursor === undefined || input.cursor === null ? null : decodeCursor(input.cursor);
      if (after === undefined)
        return yield* new ArchivedHistoryRetentionError({ message: "The cursor is not valid." });
      const now = yield* Clock.currentTimeMillis;
      const limit = input.limit ?? PLAN_PAGE;
      const threads = yield* plan({
        now,
        cutoffDays: evaluatedDays,
        onlyBeforeCutoff: false,
        projectId: input.projectId,
        after,
        limit,
        settings,
      }).pipe(Effect.provide(context));
      const last = threads.at(-1);
      const totals = {
        threads: threads.length,
        bytes: 0,
        dueThreads: 0,
        dueBytes: 0,
        keptThreads: 0,
        trimmedThreads: 0,
        structureBytes: 0,
      };
      for (const thread of threads) {
        totals.bytes += thread.bytes;
        totals.structureBytes += thread.structureBytes;
        if (thread.verdict === "due") {
          totals.dueThreads += 1;
          totals.dueBytes += thread.trimmableBytes;
        }
        if (thread.verdict === "kept") totals.keptThreads += 1;
        if (thread.verdict === "trimmed") totals.trimmedThreads += 1;
      }
      return {
        generatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        retentionDays,
        evaluatedDays,
        database: yield* readDatabase,
        lastRun: yield* readLastRun,
        totals,
        threads: threads.map(({ archivedAtRaw: _raw, ...entry }) => entry),
        nextCursor:
          threads.length < limit || last === undefined
            ? null
            : `${last.archivedAtRaw}|${last.threadId}`,
      } satisfies ArchivedThreadsListResult;
    },
    Effect.mapError((cause) =>
      cause._tag === "ArchivedHistoryRetentionError"
        ? cause
        : new ArchivedHistoryRetentionError({
            message: "Could not read archived threads.",
            cause,
          }),
    ),
  );

  const markTrimmed = Effect.fn("ArchivedHistoryRetention.markTrimmed")(
    function* (thread: PlannedThread, trimmedAt: DateTime.Utc) {
      const uuid = yield* random.uuidV4();
      yield* orchestrator.dispatch({
        type: "thread.history.mark-trimmed",
        commandId: CommandId.make(`server:history-trim:${thread.threadId}:${uuid}`),
        threadId: ThreadId.make(thread.threadId),
        archivedAt: DateTime.makeUnsafe(thread.archivedAtRaw),
        trimmedAt,
      });
      const rows = yield* sql<{ readonly archived_at: string | null }>`
        SELECT archived_at FROM orchestration_v2_projection_threads
        WHERE thread_id = ${thread.threadId}
      `;
      const archivedAt = rows[0]?.archived_at ?? null;
      return archivedAt !== null && Date.parse(archivedAt) === Date.parse(thread.archivedAtRaw)
        ? archivedAt
        : null;
    },
    Effect.orElseSucceed(() => null),
  );

  const runPass = Effect.fn("ArchivedHistoryRetention.runPass")(
    function* (betweenPages: Effect.Effect<void>) {
      const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
      const days = settings?.storageCleanup.archivedHistoryAfterDays ?? null;
      if (settings === null || days === null) return null;
      const startedMs = yield* Clock.currentTimeMillis;
      const budget = {
        deadlineMs: startedMs + PASS_MAX_MS,
        maxBytes: PASS_MAX_BYTES,
        bytesRemoved: 0,
        pageRows: PAGE_ROWS,
        pageBytes: PAGE_BYTES,
        statementMs: [] as Array<number>,
      };
      const totals = { items: 0, messages: 0, bytes: 0 };
      const kept: Record<string, number> = {};
      let threadsTrimmed = 0;
      let stoppedBy: ArchivedHistoryTrimRun["stoppedBy"] = "done";
      const trimmedAt = DateTime.makeUnsafe(startedMs);
      yield* Effect.gen(function* () {
        let after: { archivedAt: string; threadId: string } | null = null;
        while (true) {
          const page: ReadonlyArray<PlannedThread> = yield* plan({
            now: startedMs,
            cutoffDays: days,
            onlyBeforeCutoff: true,
            after,
            limit: PLAN_PAGE,
            settings,
          }).pipe(Effect.provide(context));
          for (const thread of page) {
            if (thread.verdict === "kept" && thread.keptReason !== null)
              kept[thread.keptReason] = (kept[thread.keptReason] ?? 0) + 1;
            if (thread.verdict !== "due") continue;
            if (budgetSpent(budget, yield* Clock.currentTimeMillis)) {
              stoppedBy = "cap";
              return;
            }
            const archivedAt = yield* markTrimmed(thread, trimmedAt);
            if (archivedAt === null) continue;
            const finished = yield* trimmer.trimThread({
              threadId: thread.threadId,
              archivedAt,
              budget,
              totals,
              betweenPages,
            });
            if (finished) threadsTrimmed += 1;
            yield* betweenPages;
          }
          const last = page.at(-1);
          if (page.length < PLAN_PAGE || last === undefined) return;
          after = { archivedAt: last.archivedAtRaw, threadId: last.threadId };
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Archived history trim failed", { cause }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                stoppedBy = "error";
              }),
            ),
          ),
        ),
      );
      if (budgetSpent(budget, yield* Clock.currentTimeMillis) && stoppedBy === "done")
        stoppedBy = "cap";
      const run: ArchivedHistoryTrimRun = {
        startedAt: DateTime.formatIso(trimmedAt),
        finishedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
        retentionDays: days,
        threadsTrimmed,
        itemsRemoved: totals.items,
        messagesRemoved: totals.messages,
        bytesRemoved: totals.bytes,
        kept,
        stoppedBy,
        statements: {
          count: budget.statementMs.length,
          p95Ms: percentile(budget.statementMs, 0.95),
          maxMs: percentile(budget.statementMs, 1),
          finalPageRows: budget.pageRows,
          finalPageBytes: budget.pageBytes,
        },
      };
      yield* encodeRun(run).pipe(
        Effect.flatMap((text) => fs.writeFileString(runPath, text)),
        Effect.ignore,
      );
      yield* Effect.logInfo("Trimmed archived thread history", run);
      return run;
    },
    Effect.orElseSucceed(() => null),
  );

  const passRequests = settingsService.streamChanges.pipe(
    Stream.mapAccum(
      () => undefined as number | null | undefined,
      (previous: number | null | undefined, next) => {
        const days = next.storageCleanup.archivedHistoryAfterDays;
        return [
          days,
          previous !== undefined && days !== null && (previous === null || days < previous)
            ? [undefined]
            : [],
        ] as const;
      },
    ),
  );

  return ArchivedHistoryRetention.of({
    list,
    runPass,
    passRequests,
  });
});

export const layer = Layer.effect(ArchivedHistoryRetention, make);
