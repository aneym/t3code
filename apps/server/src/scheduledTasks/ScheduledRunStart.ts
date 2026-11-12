import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type ScheduledTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const PREPARATION_FAILED = "Workspace preparation failed";
const FAILED_BEFORE_START = "The run failed before it started.";
const STOPPED_BEFORE_START = "The run was stopped before it started.";

export interface ScheduledRunStartWatch {
  readonly taskId: ScheduledTaskId;
  readonly startedAtIso: string;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly onChanged: Effect.Effect<void>;
}

export class ScheduledRunStart extends Context.Service<
  ScheduledRunStart,
  {
    readonly watch: (input: ScheduledRunStartWatch) => Effect.Effect<void>;
    readonly recover: (onChanged: Effect.Effect<void>) => Effect.Effect<void>;
  }
>()("t3/scheduledTasks/ScheduledRunStart") {}

type RunStatus = OrchestrationV2Run["status"];

const reachedWork = (status: RunStatus) =>
  status === "running" || status === "waiting" || status === "completed";

const endedEarly = (status: RunStatus) =>
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted" ||
  status === "rolled_back";

const fireKeys = (row: {
  readonly task_id: string;
  readonly last_run_at: string;
  readonly last_run_webhook_delivery_id: string | null;
}) => {
  if (row.last_run_webhook_delivery_id !== null)
    return [`${row.task_id}:webhook:${row.last_run_webhook_delivery_id}`];
  const startedAt = DateTime.make(row.last_run_at);
  if (Option.isNone(startedAt)) return [];
  const millis = DateTime.toEpochMillis(startedAt.value);
  return [`${row.task_id}:${millis}:scheduled`, `${row.task_id}:${millis}:manual`];
};

export const layer = Layer.effect(
  ScheduledRunStart,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;

    const startFailure = Effect.fn("ScheduledRunStart.startFailure")(function* (
      threadId: ThreadId,
      messageId: MessageId,
    ) {
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      const run = runs.find((candidate) => candidate.userMessageId === messageId);
      if (run === undefined || reachedWork(run.status)) return null;
      const outcome = yield* threads
        .streamStoredEventsFrom({ threadId, eventType: "run.updated" })
        .pipe(
          Stream.map(({ event }) =>
            event.type === "run.updated" && event.payload.id === run.id
              ? event.payload.status
              : null,
          ),
          Stream.filter((status) => status !== null && (reachedWork(status) || endedEarly(status))),
          Stream.runHead,
          Effect.map(Option.getOrNull),
        );
      if (outcome === null || !endedEarly(outcome)) return null;
      if (outcome !== "failed") return STOPPED_BEFORE_START;
      const { turnItems } = yield* threads.getThreadRecords(threadId, ["turnItems"], {
        turnItemRunId: run.id,
        turnItemTypes: ["command_execution"],
        turnItemStatuses: ["failed"],
      });
      const failure = turnItems.findLast(
        (item) => item.type === "command_execution" && item.title === PREPARATION_FAILED,
      );
      if (failure?.type === "command_execution") return failure.output ?? PREPARATION_FAILED;
      const shell = yield* threads.getThreadShell(threadId);
      return shell?.lastError ?? FAILED_BEFORE_START;
    });

    const watch = Effect.fn("ScheduledRunStart.watch")(
      function* (input: ScheduledRunStartWatch) {
        const failure = yield* startFailure(input.threadId, input.messageId);
        if (failure === null) return;
        const now = yield* DateTime.now;
        const rows = yield* sql<{ task_id: string }>`
        UPDATE scheduled_tasks
        SET last_run_status = 'failed',
            last_run_error = ${failure},
            updated_at = ${DateTime.formatIso(now)}
        WHERE task_id = ${input.taskId}
          AND last_run_at = ${input.startedAtIso}
          AND last_run_status = 'succeeded'
        RETURNING task_id
      `;
        if (rows.length > 0) yield* input.onChanged;
      },
      (effect, input) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not check whether a scheduled run started", {
              taskId: input.taskId,
              threadId: input.threadId,
              cause,
            }),
          ),
        ),
    );

    const launchedThread = Effect.fn("ScheduledRunStart.launchedThread")(function* (
      fireKey: string,
    ) {
      const receipt = yield* receipts.getByCommandId(CommandId.make(`scheduled-task:${fireKey}`));
      return Option.isSome(receipt) && receipt.value.status === "accepted"
        ? receipt.value.threadId
        : null;
    });

    const recover = Effect.fn("ScheduledRunStart.recover")(
      function* (onChanged: Effect.Effect<void>) {
        const rows = yield* sql<{
          task_id: ScheduledTaskId;
          last_run_at: string;
          last_run_webhook_delivery_id: string | null;
        }>`
        SELECT task_id, last_run_at, last_run_webhook_delivery_id
        FROM scheduled_tasks
        WHERE thread_id IS NULL
          AND last_run_status = 'succeeded'
          AND last_run_at IS NOT NULL
      `;
        yield* Effect.forEach(
          rows,
          (row) =>
            Effect.gen(function* () {
              for (const fireKey of fireKeys(row)) {
                const threadId = yield* launchedThread(fireKey);
                if (threadId === null) continue;
                yield* watch({
                  taskId: row.task_id,
                  startedAtIso: row.last_run_at,
                  threadId,
                  messageId: MessageId.make(`scheduled-task-message:${fireKey}`),
                  onChanged,
                });
                return;
              }
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not recover a scheduled run's start check", {
                  taskId: row.task_id,
                  cause,
                }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        );
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not recover scheduled run start checks", { cause }),
      ),
    );

    return ScheduledRunStart.of({ watch, recover });
  }),
);
