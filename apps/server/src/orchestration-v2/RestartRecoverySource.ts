import type { ServerRestartHandoff } from "@t3tools/contracts";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";
import { sessionsLiveAtStart, type RecoverySession } from "./RuntimeRecoverySessions.ts";
import { restartContinuationRun, unacceptedRestartRun } from "./RestartContinuation.ts";

export function restartRecoverySource(
  projection: ProjectionRuntimeRecoveryState,
  trigger: "startup" | "shutdown",
  stoppedThisPass: ReadonlyMap<string, RecoverySession>,
  handoff?: ServerRestartHandoff,
) {
  return handoff === undefined && trigger === "startup"
    ? (restartContinuationRun({
        ...projection,
        providerSessions: sessionsLiveAtStart(projection, stoppedThisPass),
      }) ?? unacceptedRestartRun(projection))
    : undefined;
}
