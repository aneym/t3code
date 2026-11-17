import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { Statement } from "effect/sql/Statement";

import { TERMINAL_RUN_STATUSES } from "./ArchivedHistoryPlan.ts";

export const PAGE_ROWS = 20;
export const PAGE_BYTES = 1024 * 1024;
const STATEMENT_TARGET_MS = 25;

export interface PassBudget {
  readonly deadlineMs: number;
  readonly maxBytes: number;
  bytesRemoved: number;
  pageRows: number;
  pageBytes: number;
  readonly statementMs: Array<number>;
}

export interface TrimTotals {
  items: number;
  messages: number;
  bytes: number;
}

class ThreadNoLongerTrimmable extends Schema.TaggedError<ThreadNoLongerTrimmable>()(
  "ThreadNoLongerTrimmable",
  {},
) {}

interface PageRow {
  readonly id: string;
  readonly bytes: number | null;
}

export const budgetSpent = (budget: PassBudget, nowMs: number) =>
  budget.bytesRemoved >= budget.maxBytes || nowMs >= budget.deadlineMs;

export const makeThreadTrimmer = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const timed = Effect.fn("ArchivedHistoryRetention.timed")(function* <A, E, R>(
    budget: PassBudget,
    statement: Effect.Effect<A, E, R>,
  ) {
    const started = yield* Clock.monotonicTimeNanos;
    const result = yield* statement;
    const elapsedMs = Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000;
    budget.statementMs.push(elapsedMs);
    if (elapsedMs > STATEMENT_TARGET_MS) {
      budget.pageRows = Math.max(1, Math.floor(budget.pageRows / 2));
      budget.pageBytes = Math.max(64 * 1024, Math.floor(budget.pageBytes / 2));
    }
    return result;
  });

  const kept = sql.unsafe(
    "i.parent_item_id IS NULL AND i.type IN ('user_message', 'assistant_message')",
  );

  const tables: ReadonlyArray<{
    readonly key: "items" | "messages" | "other";
    readonly select: (threadId: string, rows: number) => Statement<PageRow>;
    readonly remove: (
      threadId: string,
      ids: ReadonlyArray<string>,
    ) => ReadonlyArray<Statement<never>>;
  }> = [
    {
      key: "items",
      select: (threadId, rows) => sql<PageRow>`
        SELECT i.turn_item_id AS id, octet_length(i.payload_json) AS bytes
        FROM orchestration_v2_projection_turn_items AS i
        WHERE i.thread_id = ${threadId} AND NOT (${kept})
        ORDER BY i.ordinal, i.turn_item_id
        LIMIT ${rows}
      `,
      remove: (threadId, ids) => [
        sql`DELETE FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId} AND turn_item_id IN ${sql.in(ids)}`,
        sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id IN ${sql.in(ids)}`,
      ],
    },
    {
      key: "messages",
      select: (threadId, rows) => sql<PageRow>`
        SELECT m.message_id AS id, octet_length(m.payload_json) AS bytes
        FROM orchestration_v2_projection_messages AS m
        WHERE m.thread_id = ${threadId}
          AND m.message_id NOT IN (
            SELECT json_extract(i.payload_json, '$.messageId')
            FROM orchestration_v2_projection_turn_items AS i
            WHERE i.thread_id = ${threadId} AND ${kept}
              AND json_extract(i.payload_json, '$.messageId') IS NOT NULL
          )
        ORDER BY m.created_at, m.message_id
        LIMIT ${rows}
      `,
      remove: (_threadId, ids) => [
        sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id IN ${sql.in(ids)}`,
      ],
    },
    {
      key: "other",
      select: (threadId, rows) => sql<PageRow>`
        SELECT plan_id AS id, octet_length(payload_json) AS bytes
        FROM orchestration_v2_projection_plans WHERE thread_id = ${threadId}
        LIMIT ${rows}
      `,
      remove: (_threadId, ids) => [
        sql`DELETE FROM orchestration_v2_projection_plans WHERE plan_id IN ${sql.in(ids)}`,
      ],
    },
    {
      key: "other",
      select: (threadId, rows) => sql<PageRow>`
        SELECT item_id AS id, octet_length(text) AS bytes
        FROM mcp_app_model_context WHERE thread_id = ${threadId}
        LIMIT ${rows}
      `,
      remove: (threadId, ids) => [
        sql`DELETE FROM mcp_app_model_context
          WHERE thread_id = ${threadId} AND item_id IN ${sql.in(ids)}`,
      ],
    },
  ];

  const guarded = (
    budget: PassBudget,
    threadId: string,
    archivedAt: string,
    statements: ReadonlyArray<Statement<never>>,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const live = yield* timed(
          budget,
          sql`
            SELECT 1 AS ok FROM orchestration_v2_projection_threads
            WHERE thread_id = ${threadId} AND archived_at = ${archivedAt} AND deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId} AND status NOT IN ${sql.in(TERMINAL_RUN_STATUSES)}
              )
          `,
        );
        if (live.length === 0) return yield* new ThreadNoLongerTrimmable();
        for (const statement of statements) yield* timed(budget, statement);
      }),
    );

  const trimThread = Effect.fn("ArchivedHistoryRetention.trimThread")(function* (input: {
    readonly threadId: string;
    readonly archivedAt: string;
    readonly budget: PassBudget;
    readonly totals: TrimTotals;
    readonly betweenPages: Effect.Effect<void>;
  }) {
    const { budget, threadId, totals } = input;
    for (const table of tables) {
      while (!budgetSpent(budget, yield* Clock.currentTimeMillis)) {
        const candidates = yield* table
          .select(threadId, budget.pageRows)
          .pipe(NodeSqliteClient.readOnly);
        if (candidates.length === 0) break;
        const page: Array<PageRow> = [];
        let pageBytes = 0;
        for (const row of candidates) {
          const bytes = row.bytes ?? 0;
          if (page.length > 0 && pageBytes + bytes > budget.pageBytes) break;
          page.push(row);
          pageBytes += bytes;
        }
        const ids = page.map((row) => row.id);
        yield* guarded(budget, threadId, input.archivedAt, table.remove(threadId, ids));
        if (table.key === "items") totals.items += ids.length;
        if (table.key === "messages") totals.messages += ids.length;
        totals.bytes += pageBytes;
        budget.bytesRemoved += pageBytes;
        yield* Effect.yieldNow;
        yield* input.betweenPages;
      }
    }
    return true;
  });

  return {
    trimThread: (input: Parameters<typeof trimThread>[0]) =>
      trimThread(input).pipe(
        Effect.catchTags({ ThreadNoLongerTrimmable: () => Effect.succeed(false) }),
      ),
  };
});
