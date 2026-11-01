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
          enabled = CASE WHEN json_extract(schedule_json, '$.type') = 'once' THEN 0 ELSE enabled END,
          next_run_at = CASE WHEN json_extract(schedule_json, '$.type') = 'once' THEN NULL ELSE next_run_at END
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
