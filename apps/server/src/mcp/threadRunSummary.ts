import {
  latestProviderTurnForAttempt,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpThreadRun,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { cancelledThreadStatus } from "../orchestration-v2/TaskCancel.ts";

export function runExecutedModel(
  thread: { readonly providerTurns?: ReadonlyArray<OrchestrationV2ProviderTurn> },
  run: Pick<OrchestrationV2Run, "activeAttemptId"> | undefined,
): string | null {
  return run === undefined
    ? null
    : (latestProviderTurnForAttempt(thread.providerTurns ?? [], run.activeAttemptId)?.model ??
        null);
}

function threadRun(
  run: OrchestrationV2Run,
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn> | undefined,
): OrchestratorMcpThreadRun {
  const turn = latestProviderTurnForAttempt(providerTurns ?? [], run.activeAttemptId);
  return {
    runId: run.id,
    ordinal: run.ordinal,
    status: run.status,
    providerInstanceId: run.modelSelection.instanceId,
    model: run.modelSelection.model,
    executedModel: turn?.model ?? null,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
    ...(turn?.tokenUsage === undefined ? {} : { contextUsage: turn.tokenUsage }),
    ...(turn?.turnTokenUsage === undefined ? {} : { tokenUsage: turn.turnTokenUsage }),
    ...(turn?.permissionDenials === undefined ? {} : { permissionDenials: turn.permissionDenials }),
    ...(run.fallback === undefined ? {} : { fallback: run.fallback }),
  };
}

export function recentThreadRuns(
  target: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "providerTurns">,
  limit: number,
): ReadonlyArray<OrchestratorMcpThreadRun> {
  return target.runs
    .toSorted((left, right) => right.ordinal - left.ordinal)
    .slice(0, limit)
    .map((run, index) =>
      threadRun(
        index === 0 ? { ...run, status: cancelledThreadStatus(target.thread, run.status) } : run,
        target.providerTurns,
      ),
    );
}
