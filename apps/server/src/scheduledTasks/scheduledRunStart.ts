import type { MessageId, OrchestrationV2Run, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/sql/SqlClient";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const PREPARATION_FAILED = "Workspace preparation failed";
const PREPARATION_WAIT = Duration.minutes(30);

const failedBeforeStart = (run: Pick<OrchestrationV2Run, "status" | "startedAt">) =>
  run.status === "failed" && run.startedAt === null;

const preparationFailure = Effect.fn("ScheduledRunStart.preparationFailure")(function* (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  threadId: ThreadId,
  messageId: MessageId,
) {
  const afterSequence = yield* threads.getThreadEventSequence(threadId);
  const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
  const run = runs.find((candidate) => candidate.userMessageId === messageId);
  if (run === undefined) return null;
  const settled =
    run.status !== "preparing"
      ? run
      : yield* threads
          .streamStoredEventsFrom({ threadId, afterSequence, eventType: "run.updated" })
          .pipe(
            Stream.map(({ event }) => (event.type === "run.updated" ? event.payload : null)),
            Stream.filter((updated) => updated?.id === run.id && updated.status !== "preparing"),
            Stream.runHead,
            Effect.timeoutOption(PREPARATION_WAIT),
            Effect.map((updated) => Option.getOrNull(Option.flatten(updated))),
          );
  if (settled === null || !failedBeforeStart(settled)) return null;
  const { turnItems } = yield* threads.getThreadRecords(threadId, ["turnItems"], {
    turnItemRunId: run.id,
    turnItemTypes: ["command_execution"],
    turnItemStatuses: ["failed"],
  });
  const failure = turnItems.findLast(
    (item) => item.type === "command_execution" && item.title === PREPARATION_FAILED,
  );
  return failure?.type === "command_execution" ? (failure.output ?? PREPARATION_FAILED) : null;
});

export const watchScheduledRunStart = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly threads: ThreadManagementService.ThreadManagementService["Service"];
  readonly taskId: ScheduledTaskId;
  readonly startedAtIso: string;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly onChanged: Effect.Effect<void>;
}) =>
  preparationFailure(input.threads, input.threadId, input.messageId).pipe(
    Effect.flatMap((failure) =>
      failure === null
        ? Effect.void
        : DateTime.now.pipe(
            Effect.flatMap(
              (now) => input.sql<{ task_id: string }>`
            UPDATE scheduled_tasks
            SET last_run_status = 'failed',
                last_run_error = ${failure},
                updated_at = ${DateTime.formatIso(now)}
            WHERE task_id = ${input.taskId}
              AND last_run_at = ${input.startedAtIso}
              AND last_run_status = 'succeeded'
            RETURNING task_id
          `,
            ),
            Effect.flatMap((rows) => (rows.length > 0 ? input.onChanged : Effect.void)),
          ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not check whether a scheduled run started", {
        taskId: input.taskId,
        threadId: input.threadId,
        cause,
      }),
    ),
  );
