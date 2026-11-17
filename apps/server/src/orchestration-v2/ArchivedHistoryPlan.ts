import {
  ProjectId,
  ThreadId,
  type ArchivedThreadEntry,
  type ArchivedThreadKeptReason,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { threadHasQueuedTurnStart } from "./AutoSettlementPolicy.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { threadIdle, type LimitRecoverySettings } from "../threadIdle.ts";

const DAY_MS = 86_400_000;
export const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
] as const;

export interface PlannedThread extends ArchivedThreadEntry {
  readonly archivedAtRaw: string;
}

export interface PlanInput {
  readonly now: number;
  readonly cutoffDays: number | null;
  readonly onlyBeforeCutoff: boolean;
  readonly projectId?: ProjectId | undefined;
  readonly after: { readonly archivedAt: string; readonly threadId: string } | null;
  readonly limit: number;
  readonly settings: LimitRecoverySettings;
}

interface CandidateRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly archived_at: string;
  readonly title: string | null;
  readonly history_trimmed_at: string | null;
}

interface CountRow {
  readonly thread_id: string;
  readonly n: number;
  readonly bytes: number | null;
  readonly trimmable: number | null;
  readonly trimmable_bytes: number | null;
}

const byThread = <Row extends { readonly thread_id: string }>(rows: ReadonlyArray<Row>) =>
  new Map(rows.map((row) => [row.thread_id, row]));

const keptMessageItem = (sql: SqlClient.SqlClient, alias: string) =>
  sql.unsafe(
    `${alias}.parent_item_id IS NULL AND ${alias}.type IN ('user_message', 'assistant_message')`,
  );

export const plan = Effect.fn("ArchivedHistoryRetention.plan")(function* (input: PlanInput) {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const cutoffIso =
    input.cutoffDays === null
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(input.now - input.cutoffDays * DAY_MS));

  const candidates = yield* sql<CandidateRow>`
    SELECT thread_id, project_id, archived_at,
      json_extract(payload_json, '$.title') AS title,
      json_extract(payload_json, '$.historyTrimmedAt') AS history_trimmed_at
    FROM orchestration_v2_projection_threads
    WHERE archived_at IS NOT NULL AND deleted_at IS NULL
      ${input.onlyBeforeCutoff && cutoffIso !== null ? sql`AND archived_at < ${cutoffIso}` : sql``}
      ${input.projectId === undefined ? sql`` : sql`AND project_id = ${input.projectId}`}
      ${
        input.after === null
          ? sql``
          : sql`AND (archived_at, thread_id) > (${input.after.archivedAt}, ${input.after.threadId})`
      }
    ORDER BY archived_at, thread_id
    LIMIT ${input.limit}
  `;
  if (candidates.length === 0) return [];
  const ids = candidates.map((row) => row.thread_id);

  const items = byThread(
    yield* sql<CountRow>`
      SELECT thread_id, COUNT(*) AS n, SUM(octet_length(payload_json)) AS bytes,
        SUM(NOT (${keptMessageItem(sql, "i")})) AS trimmable,
        SUM(CASE WHEN ${keptMessageItem(sql, "i")} THEN 0 ELSE octet_length(payload_json) END)
          AS trimmable_bytes
      FROM orchestration_v2_projection_turn_items AS i
      WHERE thread_id IN ${sql.in(ids)}
      GROUP BY thread_id
    `,
  );
  const messages = byThread(
    yield* sql<CountRow>`
      WITH shown AS (
        SELECT DISTINCT i.thread_id, json_extract(i.payload_json, '$.messageId') AS message_id
        FROM orchestration_v2_projection_turn_items AS i
        WHERE i.thread_id IN ${sql.in(ids)} AND ${keptMessageItem(sql, "i")}
      )
      SELECT m.thread_id, COUNT(*) AS n, SUM(octet_length(m.payload_json)) AS bytes,
        SUM(s.message_id IS NULL) AS trimmable,
        SUM(CASE WHEN s.message_id IS NULL THEN octet_length(m.payload_json) ELSE 0 END)
          AS trimmable_bytes
      FROM orchestration_v2_projection_messages AS m
      LEFT JOIN shown AS s ON s.thread_id = m.thread_id AND s.message_id = m.message_id
      WHERE m.thread_id IN ${sql.in(ids)}
      GROUP BY m.thread_id
    `,
  );
  const extras = byThread(
    yield* sql<CountRow>`
      SELECT thread_id, SUM(n) AS n, SUM(bytes) AS bytes, SUM(n) AS trimmable,
        SUM(bytes) AS trimmable_bytes
      FROM (
        SELECT thread_id, COUNT(*) AS n, SUM(octet_length(payload_json)) AS bytes
        FROM orchestration_v2_projection_plans WHERE thread_id IN ${sql.in(ids)}
        GROUP BY thread_id
        UNION ALL
        SELECT thread_id, COUNT(*) AS n, SUM(octet_length(text)) AS bytes
        FROM mcp_app_model_context WHERE thread_id IN ${sql.in(ids)}
        GROUP BY thread_id
      )
      GROUP BY thread_id
    `,
  );
  const structure = byThread(
    yield* sql<{ readonly thread_id: string; readonly bytes: number | null }>`
      SELECT thread_id, SUM(bytes) AS bytes FROM (
        SELECT thread_id, octet_length(payload_json) AS bytes
        FROM orchestration_v2_projection_nodes WHERE thread_id IN ${sql.in(ids)}
        UNION ALL
        SELECT thread_id, octet_length(payload_json)
        FROM orchestration_v2_projection_subagents WHERE thread_id IN ${sql.in(ids)}
        UNION ALL
        SELECT thread_id, octet_length(payload_json)
        FROM orchestration_v2_projection_provider_turns WHERE thread_id IN ${sql.in(ids)}
        UNION ALL
        SELECT thread_id, octet_length(payload_json)
        FROM orchestration_v2_projection_runtime_requests WHERE thread_id IN ${sql.in(ids)}
      )
      GROUP BY thread_id
    `,
  );

  const sized = candidates.map((row) => {
    const item = items.get(row.thread_id);
    const message = messages.get(row.thread_id);
    const extra = extras.get(row.thread_id);
    const archivedMs = Date.parse(row.archived_at);
    return {
      row,
      archivedMs,
      old: cutoffIso !== null && row.archived_at < cutoffIso,
      items: item?.n ?? 0,
      messages: message?.n ?? 0,
      bytes: (item?.bytes ?? 0) + (message?.bytes ?? 0),
      trimmableItems: item?.trimmable ?? 0,
      trimmableRows: (item?.trimmable ?? 0) + (message?.trimmable ?? 0) + (extra?.trimmable ?? 0),
      trimmableBytes:
        (item?.trimmable_bytes ?? 0) +
        (message?.trimmable_bytes ?? 0) +
        (extra?.trimmable_bytes ?? 0),
      structureBytes: structure.get(row.thread_id)?.bytes ?? 0,
    };
  });

  const eligible = sized.filter((entry) => entry.old && entry.trimmableRows > 0);
  const kept = new Map<string, ArchivedThreadKeptReason>();
  if (eligible.length > 0 && cutoffIso !== null) {
    const eligibleIds = eligible.map((entry) => entry.row.thread_id);
    const keep = (threadId: string, reason: ArchivedThreadKeptReason) => {
      if (!kept.has(threadId)) kept.set(threadId, reason);
    };
    const openRuns = yield* sql<{ readonly thread_id: string; readonly status: string }>`
      SELECT thread_id, status FROM orchestration_v2_projection_runs
      WHERE thread_id IN ${sql.in(eligibleIds)} AND status NOT IN ${sql.in(TERMINAL_RUN_STATUSES)}
    `;
    const shells = yield* Effect.forEach(
      eligibleIds,
      (threadId) => projections.getThreadShell(ThreadId.make(threadId)),
      { concurrency: 1 },
    );
    for (const shell of shells) {
      if (shell === null) continue;
      if (threadHasQueuedTurnStart(shell, input.now)) keep(shell.id, "queued");
      else if (!threadIdle(shell, input.now, input.settings)) keep(shell.id, "running");
    }
    for (const run of openRuns) keep(run.thread_id, run.status === "queued" ? "queued" : "running");
    const effects = yield* sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id FROM orchestration_v2_effect_outbox
      WHERE status IN ('pending', 'running') AND thread_id IN ${sql.in(eligibleIds)}
    `;
    for (const effect of effects) keep(effect.thread_id, "pending-effect");
    const delegated = yield* sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id FROM orchestration_v2_projection_subagents
      WHERE thread_id IN ${sql.in(eligibleIds)}
        AND origin = 'app_owned' AND child_thread_id IS NOT NULL
        AND status IN ('pending', 'running', 'waiting')
    `;
    for (const task of delegated) keep(task.thread_id, "delegated-child");
    const references = yield* sql<{
      readonly thread_id: string;
      readonly archived_at: string | null;
      readonly parent: string | null;
      readonly source: string | null;
    }>`
      SELECT thread_id, archived_at,
        json_extract(payload_json, '$.lineage.parentThreadId') AS parent,
        json_extract(payload_json, '$.forkedFrom.threadId') AS source
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND (json_extract(payload_json, '$.lineage.parentThreadId') IN ${sql.in(eligibleIds)}
          OR json_extract(payload_json, '$.forkedFrom.threadId') IN ${sql.in(eligibleIds)})
    `;
    for (const child of references) {
      if (child.parent === null || child.parent === child.thread_id) continue;
      const shell = yield* projections.getThreadShell(ThreadId.make(child.thread_id));
      if (shell !== null && !threadIdle(shell, input.now, input.settings))
        keep(child.parent, "delegated-child");
    }
    const scheduled = yield* sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id FROM scheduled_tasks WHERE thread_id IN ${sql.in(eligibleIds)}
    `;
    for (const task of scheduled) keep(task.thread_id, "scheduled-task");
    for (const shell of shells) {
      if (shell === null) continue;
      if (shell.pinnedAt != null) keep(shell.id, "pinned");
      if (shell.snoozedUntil != null && DateTime.toEpochMillis(shell.snoozedUntil) > input.now)
        keep(shell.id, "snoozed");
    }
    for (const fork of references) {
      if (fork.source === null || fork.source === fork.thread_id) continue;
      if (fork.archived_at === null || fork.archived_at >= cutoffIso)
        keep(fork.source, "fork-source");
    }
  }

  return sized.map((entry): PlannedThread => {
    const keptReason = kept.get(entry.row.thread_id) ?? null;
    const verdict =
      entry.old && entry.trimmableRows > 0
        ? keptReason === null
          ? "due"
          : "kept"
        : entry.row.history_trimmed_at !== null
          ? "trimmed"
          : "not-due";
    return {
      threadId: ThreadId.make(entry.row.thread_id),
      projectId: ProjectId.make(entry.row.project_id),
      title: entry.row.title ?? "",
      archivedAt: entry.row.archived_at,
      archivedAtRaw: entry.row.archived_at,
      archivedDays: Math.max(0, Math.floor((input.now - entry.archivedMs) / DAY_MS)),
      items: entry.items,
      messages: entry.messages,
      bytes: entry.bytes,
      trimmableItems: entry.trimmableItems,
      trimmableBytes: entry.trimmableBytes,
      structureBytes: entry.structureBytes,
      historyTrimmedAt: entry.row.history_trimmed_at,
      verdict,
      keptReason: verdict === "kept" ? keptReason : null,
    };
  });
}, NodeSqliteClient.readOnly);
