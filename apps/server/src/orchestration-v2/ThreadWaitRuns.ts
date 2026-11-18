import type { OrchestrationV2Run, RunId } from "@t3tools/contracts";

import { runWindow } from "./CommandRunWindow.ts";
import type { ProjectionRecordFilter } from "./ProjectionStore.ts";

export const waitRunsFilter = (runId?: RunId): ProjectionRecordFilter => ({
  recentRuns: runWindow([runId]),
});

export function latestRestartContinuation(
  runs: ReadonlyArray<OrchestrationV2Run>,
  run: OrchestrationV2Run,
): OrchestrationV2Run {
  let current = run;
  for (let hops = 0; hops < runs.length; hops++) {
    const next = runs.find((candidate) => candidate.restartContinuationOfRunId === current.id);
    if (next === undefined) break;
    current = next;
  }
  return current;
}
