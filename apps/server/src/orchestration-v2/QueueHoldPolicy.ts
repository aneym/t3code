import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { usageLimitBlockedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

type Hold = Pick<OrchestrationV2Run, "queueHeld" | "queueHoldReason">;
type Release = "restart" | "client" | "preparation";

export function clearQueueHold(run: OrchestrationV2Run): OrchestrationV2Run {
  const { queueHoldReason: _reason, ...rest } = run;
  return { ...rest, queueHeld: false };
}

export function canReleaseQueueHold(run: OrchestrationV2Run, release: Release): boolean {
  if (run.status !== "queued" || run.queueHeld !== true) return false;
  switch (release) {
    case "restart":
      return run.queueHoldReason === "restart";
    case "client":
      return run.queueHoldReason !== undefined;
    case "preparation":
      return run.queueHoldReason === "blocked";
  }
}

export function releasesQueueHoldAtRunEnd(
  run: OrchestrationV2Run,
  ended: OrchestrationV2Run | null | undefined,
  agentThread: boolean,
): boolean {
  if (run.status !== "queued" || run.queueHeld !== true || ended == null) return false;
  switch (run.queueHoldReason) {
    case "stop":
      return false;
    case "restart":
      return true;
    case "blocked":
      return ended.status === "completed";
    case undefined:
      return agentThread;
  }
}

export function stoppedQueueHold(run: OrchestrationV2Run): Hold | undefined {
  if (run.queueHeld === true && run.queueHoldReason !== "restart") return undefined;
  return { queueHeld: true, queueHoldReason: "stop" };
}

export function recoveryQueueHold(
  run: OrchestrationV2Run,
  trigger: "startup" | "shutdown",
): OrchestrationV2Run | undefined {
  if (trigger === "startup") {
    return canReleaseQueueHold(run, "restart") ? clearQueueHold(run) : undefined;
  }
  return run.queueHeld === true
    ? undefined
    : { ...run, queueHeld: true, queueHoldReason: "restart" };
}

export function inheritedQueueHold(
  runs: ReadonlyArray<OrchestrationV2Run>,
  releasedRuns: ReadonlyArray<OrchestrationV2Run>,
  blocked: boolean,
): Hold {
  const remaining = runs.filter(
    (run) => run.status === "queued" && run.queueHeld === true && !releasedRuns.includes(run),
  );
  if (remaining.some((run) => run.queueHoldReason === undefined)) return { queueHeld: true };
  if (remaining.some((run) => run.queueHoldReason === "stop"))
    return { queueHeld: true, queueHoldReason: "stop" };
  if (blocked || remaining.some((run) => run.queueHoldReason === "blocked"))
    return { queueHeld: true, queueHoldReason: "blocked" };
  return remaining.length > 0 ? { queueHeld: true, queueHoldReason: "restart" } : {};
}

export function usageLimitHoldsQueue(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems" | "providerSessions">,
  providerInstanceId: OrchestrationV2Run["providerInstanceId"],
): boolean {
  let latestSession: OrchestrationV2ThreadProjection["providerSessions"][number] | undefined;
  for (const session of projection.providerSessions) {
    if (
      session.providerInstanceId === providerInstanceId &&
      (latestSession === undefined ||
        DateTime.isGreaterThan(session.updatedAt, latestSession.updatedAt))
    ) {
      latestSession = session;
    }
  }
  return (
    usageLimitBlockedRun(projection.runs, projection.turnItems, latestSession?.lastError ?? null)
      ?.providerInstanceId === providerInstanceId
  );
}
