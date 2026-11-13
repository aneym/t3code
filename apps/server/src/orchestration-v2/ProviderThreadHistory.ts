import {
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ModelSelection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { cancelledBeforeStart } from "./RestartBackgroundNote.ts";

/** Ordinal of the latest started fresh-context run. Runs before it never reach a provider again. */
export function contextBoundaryOrdinal(
  runs: ReadonlyArray<
    Pick<
      OrchestrationV2Run,
      "ordinal" | "freshContext" | "status" | "startedAt" | "restartContinuationOfRunId"
    >
  >,
): number {
  let boundary = 0;
  for (const run of runs) {
    if (
      run.freshContext === true &&
      run.status !== "queued" &&
      !cancelledBeforeStart(run) &&
      run.ordinal > boundary
    ) {
      boundary = run.ordinal;
    }
  }
  return boundary;
}

/** Threads with no started run (imported, or reserved by another queued run) never cross it. */
export function providerThreadPredatesBoundary(
  providerThread: Pick<OrchestrationV2ProviderThread, "firstRunOrdinal">,
  boundary: number,
): boolean {
  return (
    boundary > 0 &&
    (providerThread.firstRunOrdinal === null || providerThread.firstRunOrdinal < boundary)
  );
}

export function rootProviderThreadsForProvider(
  projection: Pick<OrchestrationV2ThreadProjection, "providerThreads" | "thread" | "runs">,
  providerInstanceId: ModelSelection["instanceId"],
): ReadonlyArray<OrchestrationV2ProviderThread> {
  const boundary = contextBoundaryOrdinal(projection.runs);
  return projection.providerThreads
    .filter(
      (providerThread) =>
        providerThread.providerInstanceId === providerInstanceId &&
        providerThread.appThreadId === projection.thread.id &&
        providerThread.ownerNodeId === null &&
        !providerThreadPredatesBoundary(providerThread, boundary),
    )
    .toSorted(
      (left, right) =>
        (right.lastRunOrdinal ?? 0) - (left.lastRunOrdinal ?? 0) ||
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
}

export function isHandoffSourceRun(run: OrchestrationV2Run): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "interrupted" ||
    // A queued request cancelled before it started never reached any provider.
    (run.status === "cancelled" && run.startedAt !== null)
  );
}

export function lastDeliveredRunForProviderThread(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
  providerThreadId: OrchestrationV2ProviderThread["id"],
): OrchestrationV2Run | undefined {
  return projection.runs.findLast(
    (run) =>
      isHandoffSourceRun(run) &&
      run.providerThreadId === providerThreadId &&
      (run.status === "completed" ||
        projection.providerTurns.some((turn) => turn.runAttemptId === run.activeAttemptId)),
  );
}
