import type { OrchestrationV2Run } from "@t3tools/contracts";

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

export function isHandoffSourceRun(run: Pick<OrchestrationV2Run, "status" | "startedAt">): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "interrupted" ||
    (run.status === "cancelled" && run.startedAt !== null)
  );
}
