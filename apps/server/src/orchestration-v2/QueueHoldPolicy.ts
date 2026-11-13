import type {
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
  usageLimitBlockedRun,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

type Hold = Pick<
  OrchestrationV2Run,
  "queueHeld" | "queueHoldReason" | "queueHeldAt" | "queueHoldFailureClass" | "queueHeldByThreadId"
>;
type Release = "restart" | "client" | "preparation";

const WAKEABLE_FAILURES: ReadonlySet<OrchestrationV2ProviderFailureClass> = new Set([
  "provider_error",
  "transport_error",
]);

export function clearQueueHold(run: OrchestrationV2Run): OrchestrationV2Run {
  const {
    queueHoldReason: _reason,
    queueHeldAt: _heldAt,
    queueHoldFailureClass: _failureClass,
    queueHeldByThreadId: _heldBy,
    ...rest
  } = run;
  return { ...rest, queueHeld: false };
}

export function queueBlock(
  heldForUser: boolean,
  failureClass: OrchestrationV2ProviderFailureClass | undefined,
): { readonly failureClass?: OrchestrationV2ProviderFailureClass } | undefined {
  if (heldForUser) return {};
  return failureClass === undefined || failureClass === "validation_error"
    ? undefined
    : { failureClass };
}

export function blockedQueueHold(
  run: OrchestrationV2Run,
  now: DateTime.Utc,
  failureClass: OrchestrationV2ProviderFailureClass | undefined,
): OrchestrationV2Run {
  return {
    ...clearQueueHold(run),
    queueHeld: true,
    queueHoldReason: "blocked",
    queueHeldAt: now,
    ...(failureClass === undefined ? {} : { queueHoldFailureClass: failureClass }),
  };
}

export function wakesBlockedQueue(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  providerInstanceId: OrchestrationV2Run["providerInstanceId"],
): boolean {
  const { thread } = projection;
  if (thread.createdBy !== "agent" || thread.archivedAt !== null || thread.deletedAt !== null)
    return false;
  const held = projection.runs.filter((run) => run.status === "queued" && run.queueHeld === true);
  return (
    held.some((run) => run.providerInstanceId === providerInstanceId) &&
    held.every(
      (run) =>
        run.queueHoldReason === "blocked" &&
        run.queueHoldFailureClass !== undefined &&
        WAKEABLE_FAILURES.has(run.queueHoldFailureClass),
    )
  );
}

export function worktreeSetupPending(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
): boolean {
  return (
    projection.thread.worktreePath === null &&
    projection.runs.some(
      (run) =>
        (run.status === "failed" || run.status === "interrupted") &&
        run.workspacePreparation?.type === "worktree",
    )
  );
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
  projection: Pick<OrchestrationV2ThreadProjection, "thread">,
): boolean {
  if (run.status !== "queued" || run.queueHeld !== true || ended == null) return false;
  switch (run.queueHoldReason) {
    case "stop":
      return false;
    case "restart":
      return true;
    case "blocked":
      return ended.status === "completed" && projection.thread.createdBy === "agent";
    case undefined:
      return projection.thread.createdBy === "agent";
  }
}

export function stoppedQueueHold(
  run: OrchestrationV2Run,
  now: DateTime.Utc,
  heldByThreadId: OrchestrationV2Run["queueHeldByThreadId"],
): OrchestrationV2Run | undefined {
  if (run.queueHeld === true && run.queueHoldReason !== "restart" && run.queueHoldReason !== "stop")
    return undefined;
  const heldBy =
    run.queueHoldReason === "stop" && heldByThreadId !== undefined
      ? run.queueHeldByThreadId
      : heldByThreadId;
  return {
    ...clearQueueHold(run),
    queueHeld: true,
    queueHoldReason: "stop",
    queueHeldAt: now,
    ...(heldBy === undefined ? {} : { queueHeldByThreadId: heldBy }),
  };
}

export function releasesStopHoldOf(heldByThreadId: OrchestrationV2Run["queueHeldByThreadId"]) {
  return (run: OrchestrationV2Run) =>
    heldByThreadId === undefined ||
    (run.queueHeld === true &&
      run.queueHoldReason === "stop" &&
      run.queueHeldByThreadId === heldByThreadId);
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
    const heldBy = stopped[0]?.queueHeldByThreadId;
    return {
      queueHeld: true,
      queueHoldReason: "stop",
      ...(queueHeldAt === undefined ? {} : { queueHeldAt }),
      ...(heldBy !== undefined && stopped.every((run) => run.queueHeldByThreadId === heldBy)
        ? { queueHeldByThreadId: heldBy }
        : {}),
    };
  }
  if (blocked) return { queueHeld: true, queueHoldReason: "blocked" };
  const blockedRun = remaining.find((run) => run.queueHoldReason === "blocked");
  if (blockedRun !== undefined) {
    const { queueHeldAt, queueHoldFailureClass } = blockedRun;
    return {
      queueHeld: true,
      queueHoldReason: "blocked",
      ...(queueHeldAt === undefined ? {} : { queueHeldAt }),
      ...(queueHoldFailureClass === undefined ? {} : { queueHoldFailureClass }),
    };
  }
  return remaining.length > 0 ? { queueHeld: true, queueHoldReason: "restart" } : {};
}

export function usageLimitHoldsQueue(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems" | "providerSessions">,
  providerInstanceId: OrchestrationV2Run["providerInstanceId"],
  now?: DateTime.Utc,
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
  const limited = usageLimitBlockedRun(
    projection.runs.filter((run) => run.providerInstanceId === providerInstanceId),
    projection.turnItems,
    latestSession?.lastError ?? null,
  );
  if (limited === null) return false;
  if (latestExecutedRun(projection.runs)?.id === limited.id) return true;
  if (now === undefined) return false;
  const resetAt = latestRootProviderFailure(limited, projection.turnItems)?.resetAt;
  return resetAt != null && Date.parse(resetAt) > DateTime.toEpochMillis(now);
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
