import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type MessageId,
  type ScheduledTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const RUN_OUTCOME_WAIT_MS = 24 * 60 * 60 * 1_000;
const UNSUCCESSFUL_RUN_ERRORS = {
  failed: "The run failed.",
  interrupted: "The run was stopped.",
  cancelled: "The run was cancelled.",
  rolled_back: "The run was rolled back.",
} as const;

// A dispatch is recorded once the message is accepted; the provider can still
// reject the turn after that, so follow the run and record its failure.
export const makeRecordScheduledRunFailure = (
  sql: SqlClient.SqlClient,
  threadManagement: ThreadManagementService.ThreadManagementService["Service"],
  notifyChanged: Effect.Effect<void>,
) =>
  Effect.fn("ScheduledTaskService.recordRunFailure")(function* (
    taskId: ScheduledTaskId,
    startedAtIso: string,
    threadId: ThreadId,
    messageId: MessageId,
    launched: boolean,
  ) {
    const shell = yield* threadManagement.getThreadShell(threadId);
    if (shell === null) return;
    const thread = { projectId: shell.projectId, threadId };
    const { runs } = yield* threadManagement.getProjectThreadRecords(thread, ["runs"]);
    const dispatched = runs.find((run) => run.userMessageId === messageId);
    if (dispatched === undefined) return;
    const { run } = yield* threadManagement.waitForThread({
      ...thread,
      runId: dispatched.id,
      timeoutMs: RUN_OUTCOME_WAIT_MS,
    });
    if (
      run === null ||
      run.status === "completed" ||
      !ThreadManagementService.isTerminalRunStatus(run.status)
    )
      return;
    const { turnItems, messages } = yield* threadManagement.getProjectThreadRecords(thread, [
      "turnItems",
      "messages",
    ]);
    // A queued message promoted to a steer cancels its run and joins the active one.
    if (
      run.status === "cancelled" &&
      messages.find((message) => message.id === messageId)?.runId !== run.id
    )
      return;
    const failure = latestRootProviderFailure(run, turnItems);
    const updated = yield* sql`
      UPDATE scheduled_tasks
      SET last_run_status = 'failed', last_run_error = ${failure?.message ?? UNSUCCESSFUL_RUN_ERRORS[run.status]}
      WHERE task_id = ${taskId} AND last_run_at = ${startedAtIso} AND last_run_status = 'succeeded'
      RETURNING task_id
    `;
    const unbound =
      launched && failure?.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE
        ? yield* sql`
            UPDATE scheduled_tasks SET thread_id = NULL
            WHERE task_id = ${taskId} AND thread_id = ${threadId}
            RETURNING task_id
          `
        : [];
    if (updated.length + unbound.length > 0) yield* notifyChanged;
  });
