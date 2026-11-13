import type { OrchestrationV2Run } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const LIMIT_RETRY_BASE_MS = 5 * 60 * 1000;
const LIMIT_RETRY_MAX_MS = 60 * 60 * 1000;
export const ROOM_CONTINUATION_COMMAND_PREFIX = "limit-room:";

const serverLimitContinuation = (run: OrchestrationV2Run) =>
  run.usageLimitContinuationOfRunId !== undefined ||
  run.userMessageId.startsWith(`continue:${ROOM_CONTINUATION_COMMAND_PREFIX}`);

export function limitRetryStreak(runs: ReadonlyArray<OrchestrationV2Run>): number {
  const executed = runs
    .filter((run) => run.startedAt !== null && run.status !== "queued")
    .toSorted((left, right) => right.ordinal - left.ordinal);
  let streak = 0;
  for (const run of executed) {
    if (run.status !== "failed" || !serverLimitContinuation(run)) break;
    streak++;
  }
  return streak;
}

export function limitRetryDueMs(input: {
  readonly resetMs: number;
  readonly failedAt: DateTime.Utc;
  readonly streak: number;
}): number {
  if (input.streak === 0) return input.resetMs;
  const backoff = Math.min(LIMIT_RETRY_BASE_MS * 2 ** (input.streak - 1), LIMIT_RETRY_MAX_MS);
  return Math.max(input.resetMs, DateTime.toEpochMillis(input.failedAt) + backoff);
}
