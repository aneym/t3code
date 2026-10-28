import { type OrchestrationV2ThreadProjection, type RunId } from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { cancelledBeforeStart, isRestartContinuationSource } from "./RestartBackgroundNote.ts";
import type { OrchestrationEffectV2 } from "./EffectOutboxModel.ts";

export function restartDispatchAllowed(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "runtimeRequests" | "providerTurns"
  >,
  sourceRunId: RunId,
  preparedHandoffs: ReadonlyArray<OrchestrationEffectV2>,
) {
  const source = projection.runs.find((run) => run.id === sourceRunId);
  const covered = (id: RunId) =>
    preparedHandoffs.some(
      (effect) =>
        effect.threadId === projection.thread.id &&
        effect.request.type === "provider-runtime.restart-handoff" &&
        !effect.request.handoff.paused &&
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
    !projection.runs.some(
      (run) =>
        run.id !== source.id &&
        run.status !== "queued" &&
        !cancelledBeforeStart(run) &&
        !(prepared && (run.restartContinuationOfRunId !== undefined || covered(run.id))) &&
        runRanAfter(run, source),
    )
  );
}
