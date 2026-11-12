import { ScheduledTaskError, type ScheduledTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const makeMarkScheduledTaskRunning = (sql: SqlClient.SqlClient) =>
  Effect.fn("ScheduledTaskService.markRunning")(function* (
    id: ScheduledTaskId,
    startedAtIso: string,
    webhookDeliveryId?: string,
  ) {
    const rows = yield* sql<{ task_id: string }>`
      UPDATE scheduled_tasks
      SET updated_at = ${startedAtIso},
          last_run_at = ${startedAtIso},
          last_run_webhook_delivery_id = ${webhookDeliveryId ?? null},
          last_run_status = 'running',
          last_run_error = NULL,
          enabled = CASE WHEN json_extract(schedule_json, '$.type') = 'once' AND julianday(COALESCE(json_extract(schedule_json, '$.runAt'), json_extract(schedule_json, '$.at'))) <= julianday(${startedAtIso}) THEN 0 ELSE enabled END,
          next_run_at = CASE WHEN json_extract(schedule_json, '$.type') = 'once' AND julianday(COALESCE(json_extract(schedule_json, '$.runAt'), json_extract(schedule_json, '$.at'))) <= julianday(${startedAtIso}) THEN NULL ELSE next_run_at END
      WHERE task_id = ${id}
      RETURNING task_id
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ScheduledTaskError({
            message: "Could not mark schedule task as running.",
            taskId: id,
            cause,
          }),
      ),
    );
    if (rows.length === 0)
      return yield* new ScheduledTaskError({
        message: "Schedule task not found.",
        taskId: id,
      });
  });

export const makeMarkScheduledTaskCompleted = (sql: SqlClient.SqlClient) =>
  Effect.fn("ScheduledTaskService.markCompleted")(function* (input: {
    readonly id: ScheduledTaskId;
    readonly completedAtIso: string;
    readonly nextRunAtIso: string | null;
    readonly status: "succeeded" | "failed";
    readonly error: string | null;
    readonly startedAtIso: string;
  }) {
    const rows = yield* sql<{ task_id: string }>`
      UPDATE scheduled_tasks
      SET updated_at = ${input.completedAtIso},
          next_run_at = ${input.nextRunAtIso},
          last_run_status = ${input.status},
          last_run_error = ${input.error},
          run_count = run_count + 1
      WHERE task_id = ${input.id}
        AND last_run_status = 'running'
        AND last_run_at = ${input.startedAtIso}
      RETURNING task_id
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ScheduledTaskError({
            message: "Could not record schedule task run.",
            taskId: input.id,
            cause,
          }),
      ),
    );
    return rows.length > 0;
  });
