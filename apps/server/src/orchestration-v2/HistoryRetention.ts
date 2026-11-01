import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const HISTORY_RETENTION_VERSION = 1;
const TRIM_ABOVE_CHARACTERS = 8192;
const KEEP_CHARACTERS = 2048;
const THREAD_PAGE_SIZE = 50;
const EVENT_PAGE_SIZE = 200;
const WRITE_BATCH_BYTES = 1024 * 1024;
const FREED_PAGES_PER_MAP_PAGE = 400;

export interface HistoryRetentionResult {
  readonly threads: number;
  readonly events: number;
  readonly turnItems: number;
  readonly skipped: number;
  readonly bytesRemoved: number;
}

export class HistoryRetentionError extends Schema.TaggedError<HistoryRetentionError>()(
  "HistoryRetentionError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

class ThreadNoLongerIdle extends Schema.TaggedError<ThreadNoLongerIdle>()(
  "ThreadNoLongerIdle",
  {},
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

const ESCAPE_SEQUENCE =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|[\]PX^_][^\u0007\u001b]*(?:\u0007|\u001b\\)|[ -/]*(?![[\]PX^_])[0-~])/y;

const escapeEnd = (text: string, start: number) => {
  ESCAPE_SEQUENCE.lastIndex = start;
  const match = ESCAPE_SEQUENCE.exec(text);
  return match === null ? undefined : start + match[0].length;
};

const headEnd = (text: string, at: number) => {
  let cut = at;
  while (cut > 0) {
    const start = text.lastIndexOf("\u001b", cut - 1);
    if (start < 0) break;
    const end = escapeEnd(text, start);
    if (end !== undefined && end <= cut) break;
    cut = start;
  }
  const code = text.charCodeAt(cut - 1);
  return code >= 0xd800 && code <= 0xdbff ? cut - 1 : cut;
};

const tailStart = (text: string, at: number) => {
  const start = text.lastIndexOf("\u001b", at - 1);
  const end = start < 0 ? undefined : escapeEnd(text, start);
  const cut = end !== undefined && end > at ? end : at;
  const code = text.charCodeAt(cut);
  return code >= 0xdc00 && code <= 0xdfff ? cut + 1 : cut;
};

const trimText = (text: string) => {
  if (text.length <= TRIM_ABOVE_CHARACTERS) return text;
  const head = headEnd(text, KEEP_CHARACTERS);
  const tail = tailStart(text, text.length - KEEP_CHARACTERS);
  return `${text.slice(0, head)}\n\n[T3 history retention v${HISTORY_RETENTION_VERSION} removed ${tail - head} characters]\n\n${text.slice(tail)}`;
};

const trimTextBlock = (block: unknown) => {
  if (block === null || typeof block !== "object") return block;
  const record = block as Record<string, unknown>;
  if (record.type !== "text" || typeof record.text !== "string") return block;
  const text = trimText(record.text);
  return text === record.text ? block : { ...record, text };
};

const trimOutput = (output: unknown) => {
  if (typeof output === "string") return trimText(output);
  const content = (output as { readonly content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return output;
  const blocks = content.map(trimTextBlock);
  return blocks.some((block, index) => block !== content[index])
    ? { ...(output as object), content: blocks }
    : output;
};

const trimItemPayload = (payloadJson: string) => {
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;
  if (typeof payload.type !== "string" || !TRIMMED_ITEM_TYPES.has(payload.type)) return undefined;
  const output = trimOutput(payload.output);
  if (output === payload.output) return undefined;
  return { itemId: String(payload.id), payload: JSON.stringify({ ...payload, output }) };
};

const withoutWorkflow = (payloadJson: string) => {
  const { workflow, ...rest } = JSON.parse(payloadJson) as Record<string, unknown>;
  if (workflow === undefined) return undefined;
  return { subagentId: String(rest.id), payload: JSON.stringify(rest) };
};

interface Rewrite {
  readonly key: number | string;
  readonly guard?: string;
  readonly payload: string;
  readonly removed: number;
}

interface Batch {
  events: Rewrite[];
  turnItems: Rewrite[];
  cost: number;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const idleThread = (cutoff: string) => sql`
    COALESCE(
      thread.deleted_at,
      thread.archived_at,
      json_extract(thread.payload_json, '$.settledAt')
    ) < ${cutoff}
    AND NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_turn_items AS item
      WHERE item.thread_id = thread.thread_id
        AND item.status IN ('pending', 'running', 'waiting')
    )
    AND NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runs AS run
      WHERE run.thread_id = thread.thread_id
        AND (
          run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
          OR COALESCE(run.completed_at, run.requested_at) >= ${cutoff}
        )
    )
  `;

  const commit = (threadId: string, cutoff: string, batch: Batch) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const idle = yield* sql`
          SELECT 1 FROM orchestration_v2_projection_threads AS thread
          WHERE thread.thread_id = ${threadId} AND ${idleThread(cutoff)}
        `;
        if (idle.length === 0) return yield* new ThreadNoLongerIdle();
        for (const rewrite of batch.events) {
          yield* sql`
            UPDATE orchestration_events SET payload_json = ${rewrite.payload}
            WHERE sequence = ${rewrite.key}
          `;
        }
        for (const rewrite of batch.turnItems) {
          const updated = yield* sql`
            UPDATE orchestration_v2_projection_turn_items SET payload_json = ${rewrite.payload}
            WHERE turn_item_id = ${rewrite.key} AND updated_at = ${rewrite.guard ?? ""}
            RETURNING turn_item_id
          `;
          if (updated.length === 0) return yield* new ThreadNoLongerIdle();
        }
      }),
    );

  const trimIdleThreads = Effect.fn("HistoryRetention.trimIdleThreads")(
    function* (input: {
      readonly idleBefore: DateTime.Utc;
      readonly betweenPages?: Effect.Effect<void>;
    }) {
      const betweenPages = input.betweenPages ?? Effect.void;
      const cutoff = DateTime.formatIso(input.idleBefore);
      const totals = { threads: 0, events: 0, turnItems: 0, skipped: 0, bytesRemoved: 0 };
      const [pageSizeRow] = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
      const pageSize = pageSizeRow?.page_size ?? 4096;
      const writeCost = (before: number, after: string) =>
        Buffer.byteLength(after) +
        pageSize * (2 + Math.ceil(before / pageSize / FREED_PAGES_PER_MAP_PAGE));

      const trimThread = Effect.fn("HistoryRetention.trimThread")(function* (threadId: string) {
        const workflowKept = new Set<string>();
        const pairedItems = new Set<string>();
        let batch: Batch = { events: [], turnItems: [], cost: 0 };
        let committed = false;
        const flush = Effect.gen(function* () {
          if (batch.events.length === 0) return true;
          const done = batch;
          batch = { events: [], turnItems: [], cost: 0 };
          const idle = yield* commit(threadId, cutoff, done).pipe(
            Effect.as(true),
            Effect.catchTags({ ThreadNoLongerIdle: () => Effect.succeed(false) }),
          );
          if (idle) {
            committed = true;
            totals.events += done.events.length;
            totals.turnItems += done.turnItems.length;
            for (const rewrite of [...done.events, ...done.turnItems]) {
              totals.bytesRemoved += rewrite.removed;
            }
          }
          yield* Effect.yieldNow;
          yield* betweenPages;
          return idle;
        });
        const queue = Effect.fn("HistoryRetention.queue")(function* (
          events: Rewrite[],
          turnItems: Rewrite[],
          cost: number,
        ) {
          if (cost > WRITE_BATCH_BYTES) {
            totals.skipped += 1;
            return true;
          }
          if (batch.cost + cost > WRITE_BATCH_BYTES && !(yield* flush)) return false;
          batch.events.push(...events);
          batch.turnItems.push(...turnItems);
          batch.cost += cost;
          return true;
        });
        const readEvent = (sequence: number) =>
          sql<{ readonly payload_json: string }>`
            SELECT payload_json FROM orchestration_events WHERE sequence = ${sequence}
          `.pipe(
            NodeSqliteClient.readOnly,
            Effect.map((rows) => rows[0]?.payload_json),
          );
        const readTurnItem = (itemId: string) =>
          sql<{ readonly updated_at: string; readonly payload_json: string }>`
            SELECT updated_at, payload_json FROM orchestration_v2_projection_turn_items
            WHERE turn_item_id = ${itemId} AND thread_id = ${threadId}
          `.pipe(
            NodeSqliteClient.readOnly,
            Effect.map((rows) => rows[0]),
          );

        let beforeSequence = Number.MAX_SAFE_INTEGER;
        while (true) {
          const page = yield* sql<{
            readonly sequence: number;
            readonly event_type: string;
            readonly bytes: number;
          }>`
            SELECT sequence, event_type, octet_length(payload_json) AS bytes
            FROM orchestration_events
            INDEXED BY idx_orchestration_events_agent_stream_sequence
            WHERE stream_id = ${threadId}
              AND application_event_version = 2
              AND aggregate_kind = 'thread'
              AND sequence < ${beforeSequence}
            ORDER BY sequence DESC
            LIMIT ${EVENT_PAGE_SIZE}
          `.pipe(NodeSqliteClient.readOnly);
          for (const row of page) {
            if (row.bytes <= TRIM_ABOVE_CHARACTERS) continue;
            if (row.event_type !== "turn-item.updated" && row.event_type !== "subagent.updated") {
              continue;
            }
            const payloadJson = yield* readEvent(row.sequence);
            if (payloadJson === undefined) continue;
            if (row.event_type === "subagent.updated") {
              const stripped = withoutWorkflow(payloadJson);
              if (stripped === undefined) continue;
              if (!workflowKept.has(stripped.subagentId)) {
                workflowKept.add(stripped.subagentId);
                continue;
              }
              const event = {
                key: row.sequence,
                payload: stripped.payload,
                removed: row.bytes - Buffer.byteLength(stripped.payload),
              };
              if (!(yield* queue([event], [], writeCost(row.bytes, event.payload)))) return;
              continue;
            }
            const trimmed = trimItemPayload(payloadJson);
            if (trimmed === undefined) continue;
            const event = {
              key: row.sequence,
              payload: trimmed.payload,
              removed: row.bytes - Buffer.byteLength(trimmed.payload),
            };
            const turnItems: Rewrite[] = [];
            let cost = writeCost(row.bytes, event.payload);
            if (!pairedItems.has(trimmed.itemId)) {
              pairedItems.add(trimmed.itemId);
              const projected = yield* readTurnItem(trimmed.itemId);
              const projectedTrim =
                projected === undefined ? undefined : trimItemPayload(projected.payload_json);
              if (projected !== undefined && projectedTrim !== undefined) {
                const before = Buffer.byteLength(projected.payload_json);
                turnItems.push({
                  key: trimmed.itemId,
                  guard: projected.updated_at,
                  payload: projectedTrim.payload,
                  removed: before - Buffer.byteLength(projectedTrim.payload),
                });
                cost += writeCost(before, projectedTrim.payload);
              }
            }
            if (!(yield* queue([event], turnItems, cost))) return;
          }
          if (page.length < EVENT_PAGE_SIZE) break;
          beforeSequence = page.at(-1)!.sequence;
          yield* betweenPages;
        }
        yield* flush;
        if (committed) totals.threads += 1;
      });

      let afterThreadId = "";
      while (true) {
        const threads = yield* sql<{ readonly thread_id: string }>`
          SELECT thread.thread_id
          FROM orchestration_v2_projection_threads AS thread
          WHERE thread.thread_id > ${afterThreadId} AND ${idleThread(cutoff)}
          ORDER BY thread.thread_id ASC
          LIMIT ${THREAD_PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
        for (const thread of threads) yield* trimThread(thread.thread_id);
        if (threads.length < THREAD_PAGE_SIZE) break;
        afterThreadId = threads.at(-1)!.thread_id;
      }
      return totals satisfies HistoryRetentionResult;
    },
    Effect.mapError((cause) => new HistoryRetentionError({ cause })),
  );

  return HistoryRetention.of({ trimIdleThreads });
});

export const layer = Layer.effect(HistoryRetention, make);
