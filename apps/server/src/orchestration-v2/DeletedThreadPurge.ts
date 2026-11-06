import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const THREAD_PAGE_SIZE = 50;
const DELETE_PAGE_SIZE = 200;

const THREAD_TABLES = [
  "orchestration_v2_turn_item_positions",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_plans",
  "orchestration_v2_projection_checkpoints",
  "orchestration_v2_projection_checkpoint_scopes",
  "orchestration_v2_projection_context_handoffs",
  "orchestration_v2_projection_runtime_requests",
  "orchestration_v2_projection_provider_turns",
  "orchestration_v2_projection_provider_threads",
  "orchestration_v2_projection_provider_session_bindings",
  "orchestration_v2_projection_subagents",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_run_attempts",
  "orchestration_v2_projection_runs",
  "orchestration_v2_legacy_imports",
  "mcp_app_model_context",
  "projection_thread_messages",
  "projection_thread_sessions",
  "projection_thread_pull_requests",
  "projection_threads",
] as const;

export interface DeletedThreadPurgeResult {
  readonly threads: number;
  readonly events: number;
  readonly turnItems: number;
}

export class DeletedThreadPurgeError extends Schema.TaggedError<DeletedThreadPurgeError>()(
  "DeletedThreadPurgeError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

class ThreadNoLongerPurgeable extends Schema.TaggedError<ThreadNoLongerPurgeable>()(
  "ThreadNoLongerPurgeable",
  {},
) {}

export class DeletedThreadPurge extends Context.Service<
  DeletedThreadPurge,
  {
    readonly purgeDeletedThreads: (input: {
      readonly deletedBefore: DateTime.Utc;
      readonly betweenPages?: Effect.Effect<void>;
    }) => Effect.Effect<DeletedThreadPurgeResult, DeletedThreadPurgeError>;
  }
>()("t3/orchestration-v2/DeletedThreadPurge") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const keptThreads = (cutoff: string) => sql`
    WITH RECURSIVE kept(thread_id) AS (
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL OR deleted_at >= ${cutoff}
      UNION
      SELECT ref.value
      FROM kept
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = kept.thread_id
      JOIN json_each(json_array(
        json_extract(thread.payload_json, '$.forkedFrom.threadId'),
        json_extract(thread.payload_json, '$.lineage.parentThreadId'),
        json_extract(thread.payload_json, '$.lineage.rootThreadId')
      )) AS ref
      WHERE ref.value IS NOT NULL
    )
    SELECT thread_id FROM kept
  `;

  const guarded = <A, E, R>(threadId: string, cutoff: string, work: Effect.Effect<A, E, R>) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const deleted = yield* sql`
          SELECT 1 FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId} AND deleted_at < ${cutoff}
        `;
        if (deleted.length === 0) return yield* new ThreadNoLongerPurgeable();
        return yield* work;
      }),
    );

  const purgeDeletedThreads = Effect.fn("DeletedThreadPurge.purgeDeletedThreads")(
    function* (input: {
      readonly deletedBefore: DateTime.Utc;
      readonly betweenPages?: Effect.Effect<void>;
    }) {
      const betweenPages = input.betweenPages ?? Effect.void;
      const cutoff = DateTime.formatIso(input.deletedBefore);
      const totals = { threads: 0, events: 0, turnItems: 0 };

      const deleteEventPage = (threadId: string) => sql<{ readonly id: number | string }>`
        DELETE FROM orchestration_events
        WHERE sequence IN (
          SELECT sequence FROM orchestration_events
          WHERE aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND NOT (application_event_version = 2 AND event_type = 'thread.created')
          LIMIT ${DELETE_PAGE_SIZE}
        )
        RETURNING sequence AS id
      `;
      const deleteTurnItemPage = (threadId: string) => sql<{ readonly id: number | string }>`
        DELETE FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id IN (
          SELECT turn_item_id FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId}
          LIMIT ${DELETE_PAGE_SIZE}
        )
        RETURNING turn_item_id AS id
      `;

      const finish = Effect.fn("DeletedThreadPurge.finish")(function* (threadId: string) {
        const referenced = yield* sql`
            SELECT 1 FROM orchestration_v2_projection_threads AS other
            WHERE other.thread_id <> ${threadId}
              AND (other.deleted_at IS NULL OR other.deleted_at >= ${cutoff})
              AND ${threadId} IN (
                json_extract(other.payload_json, '$.forkedFrom.threadId'),
                json_extract(other.payload_json, '$.lineage.parentThreadId'),
                json_extract(other.payload_json, '$.lineage.rootThreadId')
              )
            LIMIT 1
          `;
        if (referenced.length > 0) return yield* new ThreadNoLongerPurgeable();
        const events = yield* sql`
            DELETE FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
            RETURNING sequence
          `;
        totals.events += events.length;
        for (const table of THREAD_TABLES) {
          yield* sql`DELETE FROM ${sql(table)} WHERE thread_id = ${threadId}`;
        }
        yield* sql`
            DELETE FROM orchestration_v2_projection_provider_sessions
            WHERE thread_id = ${threadId}
              AND provider_session_id NOT IN (
                SELECT provider_session_id FROM orchestration_v2_projection_provider_session_bindings
              )
          `;
        yield* sql`
            DELETE FROM orchestration_v2_projection_context_transfers
            WHERE target_thread_id = ${threadId}
          `;
        yield* sql`
            DELETE FROM orchestration_command_receipts
            WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId}
          `;
        yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
      });

      const purgeThread = Effect.fn("DeletedThreadPurge.purgeThread")(function* (threadId: string) {
        const drain = Effect.fn("DeletedThreadPurge.drain")(function* (
          key: "events" | "turnItems",
        ) {
          while (true) {
            const deleted = yield* guarded(
              threadId,
              cutoff,
              key === "events" ? deleteEventPage(threadId) : deleteTurnItemPage(threadId),
            );
            totals[key] += deleted.length;
            yield* Effect.yieldNow;
            yield* betweenPages;
            if (deleted.length < DELETE_PAGE_SIZE) return;
          }
        });
        yield* drain("events");
        yield* drain("turnItems");
        yield* guarded(threadId, cutoff, finish(threadId));
        totals.threads += 1;
      });

      let afterThreadId = "";
      while (true) {
        const threads = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE thread_id > ${afterThreadId}
            AND deleted_at < ${cutoff}
            AND thread_id NOT IN (${keptThreads(cutoff)})
          ORDER BY thread_id ASC
          LIMIT ${THREAD_PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
        for (const thread of threads) {
          yield* purgeThread(thread.thread_id).pipe(
            Effect.catchTags({ ThreadNoLongerPurgeable: () => Effect.void }),
          );
        }
        if (threads.length < THREAD_PAGE_SIZE) break;
        afterThreadId = threads.at(-1)!.thread_id;
      }
      return totals satisfies DeletedThreadPurgeResult;
    },
    Effect.mapError((cause) => new DeletedThreadPurgeError({ cause })),
  );

  return DeletedThreadPurge.of({ purgeDeletedThreads });
});

export const layer = Layer.effect(DeletedThreadPurge, make);
