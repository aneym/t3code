import type {
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

import type { ThreadHistoryMeta } from "./threadHistoryMerge.ts";

export function isActiveThread(thread: OrchestrationV2ThreadProjection): boolean {
  return thread.runs.some(
    (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
  );
}

export function snapshotToPersist(
  snapshotSequence: number,
  projection: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
  acceptsBoundedSnapshots: boolean,
): OrchestrationV2ThreadDetailSnapshot {
  if (acceptsBoundedSnapshots || history.hasMoreHistory || history.historyCursor !== null) {
    return {
      snapshotSequence,
      projection,
      historyCursor: history.historyCursor,
      hasMoreHistory: history.hasMoreHistory,
      latestLocalTurnOrdinal: history.latestLocalTurnOrdinal,
    };
  }
  return { snapshotSequence, projection };
}

export function shouldPersistThread(
  thread: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
): boolean {
  return !history.expanded;
}
