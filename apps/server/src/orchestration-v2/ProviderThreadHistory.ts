import {
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ModelSelection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function rootProviderThreadsForProvider(
  projection: Pick<OrchestrationV2ThreadProjection, "providerThreads" | "thread">,
  providerInstanceId: ModelSelection["instanceId"],
): ReadonlyArray<OrchestrationV2ProviderThread> {
  return projection.providerThreads
    .filter(
      (providerThread) =>
        providerThread.providerInstanceId === providerInstanceId &&
        providerThread.appThreadId === projection.thread.id &&
        providerThread.ownerNodeId === null,
    )
    .toSorted(
      (left, right) =>
        (right.lastRunOrdinal ?? 0) - (left.lastRunOrdinal ?? 0) ||
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
}

export function isHandoffSourceRun(run: OrchestrationV2Run): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "interrupted";
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
