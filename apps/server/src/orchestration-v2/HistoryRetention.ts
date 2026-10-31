import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const HISTORY_RETENTION_VERSION = 1;
const TRIM_ABOVE_CHARACTERS = 8192;
const KEEP_HEAD_CHARACTERS = 2048;
const KEEP_TAIL_CHARACTERS = 2048;
const THREAD_PAGE_SIZE = 50;
const ROW_PAGE_SIZE = 20;
const WRITE_BATCH_BYTES = 1024 * 1024;

export interface HistoryRetentionResult {
  readonly threads: number;
  readonly events: number;
  readonly turnItems: number;
  readonly bytesRemoved: number;
}

export class HistoryRetentionError extends Schema.TaggedError<HistoryRetentionError>()(
  "HistoryRetentionError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

export class HistoryRetention extends Context.Service<
  HistoryRetention,
  {
    readonly trimIdleThreads: (input: {
      readonly idleBefore: DateTime.Utc;
      readonly betweenPages?: Effect.Effect<void>;
    }) => Effect.Effect<HistoryRetentionResult, HistoryRetentionError>;
  }
>()("t3/orchestration-v2/HistoryRetention") {}

const TRIMMED_ITEM_TYPES = new Set(["command_execution", "dynamic_tool"]);

const trimOutput = (output: unknown): string | undefined => {
  if (output === undefined || output === null) return undefined;
  const text = typeof output === "string" ? output : JSON.stringify(output);
  if (text.length <= TRIM_ABOVE_CHARACTERS) return undefined;
  const removed = text.length - KEEP_HEAD_CHARACTERS - KEEP_TAIL_CHARACTERS;
  return `${text.slice(0, KEEP_HEAD_CHARACTERS)}\n\n[T3 history retention v${HISTORY_RETENTION_VERSION} removed ${removed} characters]\n\n${text.slice(-KEEP_TAIL_CHARACTERS)}`;
};

const trimItemPayload = (payloadJson: string): string | undefined => {
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;
  if (typeof payload.type !== "string" || !TRIMMED_ITEM_TYPES.has(payload.type)) return undefined;
  const output = trimOutput(payload.output);
  return output === undefined ? undefined : JSON.stringify({ ...payload, output });
};

const withoutWorkflow = (payloadJson: string) => {
  const { workflow, ...rest } = JSON.parse(payloadJson) as Record<string, unknown>;
  if (workflow === undefined) return undefined;
  return { subagentId: String(rest.id), payload: JSON.stringify(rest) };
};

type Rewrite = { readonly key: string | number; readonly guard?: string; readonly payload: string };

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const write = (table: "events" | "turnItems", rewrites: ReadonlyArray<Rewrite>) =>
    rewrites.length === 0
      ? Effect.void
      : sql.withTransaction(
          Effect.forEach(
            rewrites,
            (rewrite) =>
              table === "events"
                ? sql`
                    UPDATE orchestration_events SET payload_json = ${rewrite.payload}
                    WHERE sequence = ${rewrite.key}
                  `
                : sql`
                    UPDATE orchestration_v2_projection_turn_items
                    SET payload_json = ${rewrite.payload}
                    WHERE turn_item_id = ${rewrite.key} AND updated_at = ${rewrite.guard ?? ""}
                  `,
            { discard: true },
          ),
        );

  const trimIdleThreads = Effect.fn("HistoryRetention.trimIdleThreads")(
    function* (input: {
      readonly idleBefore: DateTime.Utc;
      readonly betweenPages?: Effect.Effect<void>;
    }) {
      const betweenPages = input.betweenPages ?? Effect.void;
      const cutoff = DateTime.formatIso(input.idleBefore);
      const totals = { threads: 0, events: 0, turnItems: 0, bytesRemoved: 0 };
      const pending: { events: Rewrite[]; turnItems: Rewrite[]; bytes: number } = {
        events: [],
        turnItems: [],
        bytes: 0,
      };
      const flush = Effect.gen(function* () {
        yield* write("events", pending.events);
        yield* write("turnItems", pending.turnItems);
        pending.events = [];
        pending.turnItems = [];
        pending.bytes = 0;
        yield* Effect.yieldNow;
        yield* betweenPages;
      });
      const queue = (table: "events" | "turnItems", before: string, rewrite: Rewrite) => {
        pending[table].push(rewrite);
        pending.bytes += rewrite.payload.length;
        totals[table] += 1;
        totals.bytesRemoved += Buffer.byteLength(before) - Buffer.byteLength(rewrite.payload);
        return pending.bytes >= WRITE_BATCH_BYTES ? flush : Effect.void;
      };

      const trimThread = Effect.fn("HistoryRetention.trimThread")(function* (threadId: string) {
        const before = totals.events + totals.turnItems;
        const workflowKept = new Set<string>();
        let throughSequence = Number.MAX_SAFE_INTEGER;
        while (true) {
          const rows = yield* sql<{
            readonly sequence: number;
            readonly event_type: string;
            readonly payload_json: string;
          }>`
          SELECT sequence, event_type, payload_json
          FROM orchestration_events
          WHERE stream_id = ${threadId}
            AND application_event_version = 2
            AND aggregate_kind = 'thread'
            AND sequence < ${throughSequence}
            AND event_type IN ('turn-item.updated', 'subagent.updated')
            AND octet_length(payload_json) > ${TRIM_ABOVE_CHARACTERS}
          ORDER BY sequence DESC
          LIMIT ${ROW_PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
          for (const row of rows) {
            if (row.event_type === "turn-item.updated") {
              const payload = trimItemPayload(row.payload_json);
              if (payload !== undefined) {
                yield* queue("events", row.payload_json, { key: row.sequence, payload });
              }
              continue;
            }
            const stripped = withoutWorkflow(row.payload_json);
            if (stripped === undefined) continue;
            if (!workflowKept.has(stripped.subagentId)) {
              workflowKept.add(stripped.subagentId);
              continue;
            }
            yield* queue("events", row.payload_json, {
              key: row.sequence,
              payload: stripped.payload,
            });
          }
          if (rows.length < ROW_PAGE_SIZE) break;
          throughSequence = rows.at(-1)!.sequence;
          yield* betweenPages;
        }

        let afterTurnItemId = "";
        while (true) {
          const rows = yield* sql<{
            readonly turn_item_id: string;
            readonly updated_at: string;
            readonly payload_json: string;
          }>`
          SELECT turn_item_id, updated_at, payload_json
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId}
            AND turn_item_id > ${afterTurnItemId}
            AND type IN ('command_execution', 'dynamic_tool')
            AND octet_length(payload_json) > ${TRIM_ABOVE_CHARACTERS}
          ORDER BY turn_item_id ASC
          LIMIT ${ROW_PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
          for (const row of rows) {
            const payload = trimItemPayload(row.payload_json);
            if (payload !== undefined) {
              yield* queue("turnItems", row.payload_json, {
                key: row.turn_item_id,
                guard: row.updated_at,
                payload,
              });
            }
          }
          if (rows.length < ROW_PAGE_SIZE) break;
          afterTurnItemId = rows.at(-1)!.turn_item_id;
          yield* betweenPages;
        }
        if (totals.events + totals.turnItems > before) totals.threads += 1;
      });

      let afterThreadId = "";
      while (true) {
        const threads = yield* sql<{ readonly thread_id: string }>`
        SELECT thread.thread_id
        FROM orchestration_v2_projection_threads AS thread
        WHERE thread.thread_id > ${afterThreadId}
          AND COALESCE(
            thread.deleted_at,
            thread.archived_at,
            json_extract(thread.payload_json, '$.settledAt')
          ) < ${cutoff}
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_turn_items AS item
            WHERE item.thread_id = thread.thread_id
              AND item.status IN ('pending', 'running', 'waiting')
          )
        ORDER BY thread.thread_id ASC
        LIMIT ${THREAD_PAGE_SIZE}
      `.pipe(NodeSqliteClient.readOnly);
        for (const thread of threads) yield* trimThread(thread.thread_id);
        if (threads.length < THREAD_PAGE_SIZE) break;
        afterThreadId = threads.at(-1)!.thread_id;
      }
      yield* flush;
      return totals satisfies HistoryRetentionResult;
    },
    Effect.mapError((cause) => new HistoryRetentionError({ cause })),
  );

  return HistoryRetention.of({ trimIdleThreads });
});

export const layer = Layer.effect(HistoryRetention, make);
