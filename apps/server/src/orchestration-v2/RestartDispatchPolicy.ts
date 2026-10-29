import {
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type RunId,
} from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { cancelledBeforeStart, isRestartContinuationSource } from "./RestartBackgroundNote.ts";
import type { OrchestrationEffectV2 } from "./EffectOutboxModel.ts";

export function restartSourceSuperseded(
  runs: ReadonlyArray<OrchestrationV2Run>,
  source: OrchestrationV2Run,
  preparedSource?: (id: RunId) => boolean,
) {
  return runs.some(
    (run) =>
      run.id !== source.id &&
      run.status !== "queued" &&
      !cancelledBeforeStart(run) &&
      !(
        preparedSource !== undefined &&
        (run.restartContinuationOfRunId !== undefined || preparedSource(run.id))
      ) &&
      runRanAfter(run, source),
  );
}

type DispatchProjection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "runtimeRequests" | "providerTurns"
>;

function restartDispatchPreparation(
  projection: DispatchProjection,
  sourceRunId: RunId,
  preparedHandoffs: ReadonlyArray<OrchestrationEffectV2>,
) {
  const covered = (id: RunId) =>
    preparedHandoffs.some(
      (effect) =>
        effect.threadId === projection.thread.id &&
        effect.request.type === "provider-runtime.restart-handoff" &&
        projection.thread.settledOverride !== "settled" &&
        effect.request.handoff.runIds.includes(id),
    );
  const prepared =
    projection.runtimeRequests.some(
      (request) =>
        request.status === "resolved" &&
        request.decision !== "decline" &&
        request.decision !== "cancel" &&
        Object.values(request.answers ?? {}).some(
          (answer) => typeof answer === "string" && answer.trim().length > 0,
        ) &&
        request.restartContinuationRunIds?.includes(sourceRunId),
    ) || covered(sourceRunId);
  return { prepared, covered };
}

export function restartSourceSupersededAtDispatch(
  projection: DispatchProjection,
  source: OrchestrationV2Run,
  preparedHandoffs: ReadonlyArray<OrchestrationEffectV2>,
) {
  const { prepared, covered } = restartDispatchPreparation(projection, source.id, preparedHandoffs);
  return restartSourceSuperseded(projection.runs, source, prepared ? covered : undefined);
}

export function restartDispatchAllowed(
  projection: DispatchProjection,
  sourceRunId: RunId,
  preparedHandoffs: ReadonlyArray<OrchestrationEffectV2>,
) {
  const source = projection.runs.find((run) => run.id === sourceRunId);
  const { prepared } = restartDispatchPreparation(projection, sourceRunId, preparedHandoffs);
  return (
    source !== undefined &&
    !projection.runtimeRequests.some(
      (request) =>
        request.status === "pending" && request.restartContinuationRunIds?.includes(sourceRunId),
    ) &&
    !projection.runs.some((run) => run.restartContinuationOfRunId === source.id) &&
    (prepared
      ? source.status === "cancelled"
      : isRestartContinuationSource(source, projection.providerTurns)) &&
    projection.thread.archivedAt === null &&
    projection.thread.deletedAt === null &&
    projection.thread.providerInstanceId === source.providerInstanceId &&
    !restartSourceSupersededAtDispatch(projection, source, preparedHandoffs)
  );
}
