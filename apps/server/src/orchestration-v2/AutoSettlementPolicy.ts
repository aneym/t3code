import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

function toMillis(value: DateTime.Utc | null | undefined): number | null {
  return value == null ? null : DateTime.toEpochMillis(value);
}

export function threadHasQueuedTurnStart(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "latestUserMessageAt"
    | "latestRunRequestedAt"
    | "latestRunStartedAt"
    | "latestRunCompletedAt"
    | "latestRunId"
    | "status"
  >,
  nowMs: number,
): boolean {
  const messageAtMs = toMillis(thread.latestUserMessageAt);
  if (messageAtMs === null || thread.status === "failed") return false;
  const age = nowMs - messageAtMs;
  if (Number.isNaN(age) || Math.abs(age) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestRunId === null) return true;
  return [
    toMillis(thread.latestRunRequestedAt),
    toMillis(thread.latestRunStartedAt),
    toMillis(thread.latestRunCompletedAt),
  ].every((value) => value === null || value < messageAtMs);
}

export function isAutoSettlementCandidate(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "id"
    | "archivedAt"
    | "settledOverride"
    | "pinnedAt"
    | "autoSettleDisabledAt"
    | "pendingRuntimeRequest"
    | "pendingGuestMessageCount"
    | "activityRunStatus"
    | "pendingBackgroundTasks"
    | "snoozedUntil"
    | "snoozedAt"
    | "latestRunCompletedAt"
    | "latestUserMessageAt"
    | "latestRunRequestedAt"
    | "latestRunStartedAt"
    | "latestRunId"
    | "status"
  >,
  nowMs: number,
  agentMainThreads?: ReadonlySet<string>,
): boolean {
  if (agentMainThreads?.has(thread.id)) return false;
  if (thread.archivedAt !== null || thread.settledOverride !== null) return false;
  if (thread.pinnedAt != null || thread.autoSettleDisabledAt != null) return false;
  if (thread.pendingRuntimeRequest !== null) return false;
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return false;
  if (thread.activityRunStatus != null) return false;
  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])) return false;
  if (threadHasQueuedTurnStart(thread, nowMs)) return false;
  return !isSnoozed(thread, nowMs);
}

export function isSnoozed(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "snoozedUntil"
    | "snoozedAt"
    | "latestRunCompletedAt"
    | "status"
    | "pendingRuntimeRequest"
    | "pendingGuestMessageCount"
  >,
  nowMs: number,
): boolean {
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  if (snoozedUntilMs === null || snoozedUntilMs <= nowMs) return false;
  if (thread.pendingRuntimeRequest !== null) return false;
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return false;
  const snoozedAtMs = toMillis(thread.snoozedAt);
  const completedAtMs = toMillis(thread.latestRunCompletedAt);
  const wokeOnError =
    thread.status === "failed" &&
    (snoozedAtMs === null || (completedAtMs !== null && completedAtMs > snoozedAtMs));
  return !wokeOnError;
}
