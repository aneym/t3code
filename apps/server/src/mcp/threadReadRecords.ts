import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const MIN_THREAD_READ_RUNS = 10;

export const loadThreadReadRecords = Effect.fn("OrchestratorMcpService.loadThreadReadRecords")(
  function* (
    threadManagement: ThreadManagementService.ThreadManagementServiceShape,
    shell: OrchestrationV2ThreadShell,
    readerThreadId: ThreadId | undefined,
    runLimit: number,
  ) {
    const input = { projectId: shell.projectId, threadId: shell.id };
    if (
      readerThreadId !== undefined &&
      shell.lineage.parentThreadId === readerThreadId &&
      shell.lineage.relationshipToParent === "subagent"
    ) {
      const target = yield* threadManagement.getProjectThreadRecords(input, [
        "runs",
        "providerTurns",
        "runtimeRequests",
        "contextTransfers",
      ]);
      return { target, runCount: target.runs.length };
    }
    const newestRuns = Math.max(runLimit, MIN_THREAD_READ_RUNS);
    const bounded = yield* threadManagement.getProjectThreadRecords(
      input,
      ["runs", "runtimeRequests"],
      {
        newestRuns,
        runStatuses: [...ThreadManagementService.ACTIVE_RUN_STATUSES, "queued"],
        runtimeRequestStatuses: ["pending"],
      },
    );
    const truncated = bounded.runs.length >= newestRuns;
    const runCount = truncated
      ? yield* threadManagement.getRunCount(shell.id)
      : bounded.runs.length;
    const records =
      bounded.runs.length < runCount && ThreadManagementService.latestRun(bounded) === undefined
        ? yield* threadManagement.getProjectThreadRecords(input, ["runs", "runtimeRequests"], {
            runtimeRequestStatuses: ["pending"],
          })
        : bounded;
    const { providerTurns } = yield* threadManagement.getProjectThreadRecords(
      input,
      ["providerTurns"],
      {
        providerTurnAttemptIds: records.runs.flatMap((run) =>
          run.activeAttemptId === null ? [] : [run.activeAttemptId],
        ),
      },
    );
    const target: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "runs" | "providerTurns" | "runtimeRequests" | "contextTransfers"
    > = { ...records, providerTurns, contextTransfers: [] };
    return { target, runCount };
  },
);
