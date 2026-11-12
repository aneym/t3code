import type * as ProjectionStore from "./ProjectionStore.ts";

export type RecoverySession =
  ProjectionStore.ProjectionRuntimeRecoveryState["providerSessions"][number];
/** Shared sessions stop on their first recovered thread; later threads still decide wakes from pre-recovery liveness. */
export const sessionsLiveAtStart = (
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
  stoppedThisPass: ReadonlyMap<string, RecoverySession>,
) => {
  const sessions = new Map(projection.providerSessions.map((session) => [session.id, session]));
  for (const providerThread of projection.providerThreads) {
    const stopped =
      providerThread.providerSessionId === null
        ? undefined
        : stoppedThisPass.get(providerThread.providerSessionId);
    if (stopped !== undefined) sessions.set(stopped.id, stopped);
  }
  return [...sessions.values()];
};
