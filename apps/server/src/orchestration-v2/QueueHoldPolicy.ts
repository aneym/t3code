import {
  resolveProviderInstanceEnabled,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  usageLimitBlockedRun,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

type Hold = Pick<OrchestrationV2Run, "queueHeld" | "queueHoldReason" | "queueHeldAt">;
type Release = "restart" | "client" | "preparation";

export function clearQueueHold(run: OrchestrationV2Run): OrchestrationV2Run {
  const { queueHoldReason: _reason, queueHeldAt: _heldAt, ...rest } = run;
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
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "turnItems" | "runs">,
  recovering = false,
): boolean {
  if (ended == null && recovering && run.queueHoldReason === "stop") {
    ended = latestExecutedRun(projection.runs);
  }
  if (run.status !== "queued" || run.queueHeld !== true || ended == null) return false;
  switch (run.queueHoldReason) {
    case "stop":
      return releasesStopHold(run, ended, projection);
    case "restart":
      return true;
    case "blocked":
      return ended.status === "completed";
    case undefined:
      return projection.thread.createdBy === "agent";
  }
}

function releasesStopHold(
  run: OrchestrationV2Run,
  ended: OrchestrationV2Run,
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "turnItems">,
): boolean {
  if (
    projection.thread.createdBy !== "agent" ||
    !["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(ended.status) ||
    ended.completedAt === null
  )
    return false;
  let heldAt = run.queueHeldAt;
  for (const item of projection.turnItems) {
    if (
      item.type === "run_interrupt_request" &&
      item.startedAt !== null &&
      run.queueHeldAt === undefined &&
      (heldAt === undefined || DateTime.isGreaterThan(item.startedAt, heldAt))
    ) {
      heldAt = item.startedAt;
    }
  }
  return heldAt !== undefined && DateTime.isGreaterThanOrEqualTo(ended.completedAt, heldAt);
}

export function stoppedQueueHold(run: OrchestrationV2Run, now: DateTime.Utc): Hold | undefined {
  if (run.queueHeld === true && run.queueHoldReason !== "restart" && run.queueHoldReason !== "stop")
    return undefined;
  return { queueHeld: true, queueHoldReason: "stop", queueHeldAt: now };
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
  const stopped = remaining.filter((run) => run.queueHoldReason === "stop");
  if (stopped.length > 0) {
    const queueHeldAt = stopped.reduce<OrchestrationV2Run["queueHeldAt"]>(
      (latest, run) =>
        run.queueHeldAt !== undefined &&
        (latest === undefined || DateTime.isGreaterThan(run.queueHeldAt, latest))
          ? run.queueHeldAt
          : latest,
      undefined,
    );
    return {
      queueHeld: true,
      queueHoldReason: "stop",
      ...(queueHeldAt === undefined ? {} : { queueHeldAt }),
    };
  }
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

export function providerInstanceDisabledForProject(
  settings: Pick<ServerSettings, "projectSettingsOverrides" | "providerInstances">,
  projectId: OrchestrationV2ThreadProjection["thread"]["projectId"],
  providerInstanceId: OrchestrationV2Run["providerInstanceId"],
): boolean {
  const projectOverride =
    settings.projectSettingsOverrides[projectId]?.providerInstances?.[providerInstanceId]?.enabled;
  if (projectOverride !== undefined) return !projectOverride;
  const machineInstance = Object.hasOwn(settings.providerInstances, providerInstanceId)
    ? settings.providerInstances[providerInstanceId]
    : undefined;
  return machineInstance !== undefined && !resolveProviderInstanceEnabled(machineInstance);
}

export function queueReleaseEvents(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  now: DateTime.Utc,
  release: (run: OrchestrationV2Run) => boolean = () => true,
) {
  const queued = projection.runs.filter((run) => run.status === "queued");
  return queued.length === 0
    ? [
        {
          type: "thread.metadata-updated" as const,
          threadId: projection.thread.id,
          occurredAt: now,
          payload: projection.thread,
        },
      ]
    : queued.filter(release).map((run) => ({
        type: "run.updated" as const,
        threadId: projection.thread.id,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: clearQueueHold(run),
      }));
}
