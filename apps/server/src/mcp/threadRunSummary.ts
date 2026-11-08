import {
  latestProviderTurnForAttempt,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestratorMcpThreadRun,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function threadRun(
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
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
    ...(turn?.tokenUsage === undefined ? {} : { contextUsage: turn.tokenUsage }),
    ...(turn?.turnTokenUsage === undefined ? {} : { tokenUsage: turn.turnTokenUsage }),
    ...(turn?.permissionDenials === undefined ? {} : { permissionDenials: turn.permissionDenials }),
  };
}
