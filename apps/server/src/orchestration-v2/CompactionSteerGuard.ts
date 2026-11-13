import type { OrchestrationV2ThreadProjection, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OrchestratorProjectionError } from "./OrchestratorErrors.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

function hasRunningCompaction(
  projection: Pick<OrchestrationV2ThreadProjection, "turnItems">,
  runId: RunId,
): boolean {
  return projection.turnItems.some(
    (item) => item.runId === runId && item.type === "compaction" && item.status === "running",
  );
}

export const runIsCompacting = Effect.fnUntraced(function* (
  store: ProjectionStoreV2Shape,
  threadId: ThreadId,
  runId: RunId,
  projection: Pick<OrchestrationV2ThreadProjection, "turnItems">,
) {
  if (hasRunningCompaction(projection, runId)) return true;
  const stored = yield* store
    .getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["compaction"],
      turnItemStatuses: ["running"],
      turnItemRunId: runId,
    })
    .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
  return hasRunningCompaction(stored, runId);
});
