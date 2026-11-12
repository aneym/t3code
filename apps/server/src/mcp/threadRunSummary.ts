import {
  latestProviderTurnForAttempt,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestratorMcpThreadRun,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { runNativeSessionId } from "./runNativeSession.ts";

interface RunSources {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly providerTurns?: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
}

export function recentThreadRuns(
  thread: RunSources,
  limit: number,
): ReadonlyArray<OrchestratorMcpThreadRun> {
  return thread.runs
    .toSorted((left, right) => right.ordinal - left.ordinal)
    .slice(0, limit)
    .map((run) => threadRun(run, thread));
}

function threadRun(run: OrchestrationV2Run, thread: RunSources): OrchestratorMcpThreadRun {
  const turn = latestProviderTurnForAttempt(thread.providerTurns ?? [], run.activeAttemptId);
  return {
    runId: run.id,
    ordinal: run.ordinal,
    status: run.status,
    providerInstanceId: run.modelSelection.instanceId,
    model: run.modelSelection.model,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
    nativeSessionId: runNativeSessionId(run, thread.providerThreads),
    ...(turn?.tokenUsage === undefined ? {} : { contextUsage: turn.tokenUsage }),
    ...(turn?.turnTokenUsage === undefined ? {} : { tokenUsage: turn.turnTokenUsage }),
    ...(turn?.permissionDenials === undefined ? {} : { permissionDenials: turn.permissionDenials }),
  };
}
