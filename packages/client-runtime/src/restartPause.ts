import type { OrchestrationV2Run } from "@t3tools/contracts";

type RestartRun = Pick<
  OrchestrationV2Run,
  | "id"
  | "ordinal"
  | "status"
  | "restartContinuationOfRunId"
  | "restartDeclined"
  | "restartHandoffPending"
>;

function restartPausedRunIds(runs: ReadonlyArray<RestartRun>) {
  const continued = new Set(
    runs.flatMap((run) =>
      run.restartContinuationOfRunId === undefined ||
      !["queued", "preparing", "starting", "running", "waiting"].includes(run.status)
        ? []
        : [run.restartContinuationOfRunId],
    ),
  );
  return new Set(
    runs
      .filter(
        (run) =>
          run.status === "cancelled" &&
          run.restartDeclined === undefined &&
          (run.restartHandoffPending === true || continued.has(run.id)),
      )
      .map((run) => run.id),
  );
}

export function restartPauseLabel(runs: ReadonlyArray<RestartRun>) {
  const paused = restartPausedRunIds(runs);
  const source = runs.findLast((run) => paused.has(run.id));
  if (source === undefined) return null;
  const successor = runs.find((run) => run.restartContinuationOfRunId === source.id);
  return `Turn ${source.ordinal} paused by a T3 Code update${successor === undefined ? "" : ` · continued in turn ${successor.ordinal}`}`;
}
