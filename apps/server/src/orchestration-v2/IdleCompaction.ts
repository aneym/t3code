import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { COMPACTION_SUGGESTION_MIN_TOKENS } from "@t3tools/shared/claudeCompaction";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

const MIN_CONTEXT_TOKENS = COMPACTION_SUGGESTION_MIN_TOKENS;
const NEON_AUTO_COMPACT_MIN_TOKENS = 140_000;
const NEON_IDLE_COMPACT_DELAY_MS = 15_000;
const LEAD_MS = 2 * 60_000;

export function isGeminiNeonModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("gemini-4-neon");
}

export type IdleCompactionRecords = Pick<
  OrchestrationV2ThreadProjection,
  | "thread"
  | "runs"
  | "messages"
  | "providerThreads"
  | "providerTurns"
  | "runtimeRequests"
  | "turnItems"
  | "contextTransfers"
>;

/**
 * When an idle Claude thread should compact, or null when it should not. The
 * window ends when the prompt cache of Claude's last request expires (1h on
 * subscriptions, 5m on API keys); compacting after that pays a full uncached
 * read.
 */
export function idleCompactionWindow(
  {
    thread,
    runs,
    messages,
    providerThreads,
    providerTurns,
    runtimeRequests,
    turnItems,
    contextTransfers,
  }: IdleCompactionRecords,
  nowMs: number,
  options?: { readonly supportsCompaction?: boolean },
): {
  readonly runId: (typeof runs)[number]["id"];
  readonly startMs: number;
  readonly endMs: number;
} | null {
  if (options?.supportsCompaction === false) return null;
  if (thread.deletedAt !== null || thread.archivedAt !== null) return null;
  if (thread.settledAt !== null || thread.settledOverride === "settled") return null;
  if (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
    return null;
  if (thread.lineage.relationshipToParent === "subagent") return null;
  const latestRun = runs.reduce<(typeof runs)[number] | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  if (latestRun?.status !== "completed" || latestRun.completedAt === null) return null;
  const message = messages.find((candidate) => candidate.id === latestRun.userMessageId);
  // Never compact a compaction, so one idle spell compacts at most once.
  if (message === undefined || message.text.trim().toLowerCase() === "/compact") return null;
  if (
    runtimeRequests.some((request) => request.status === "pending") ||
    // A pending merge-back belongs to the user's next message.
    contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    ) ||
    // Background work reports into the next turn; compaction would swallow it.
    derivePendingBackgroundWork({
      latestRun,
      runs,
      providerThreads,
      turnItems,
      activeProviderThreadId: thread.activeProviderThreadId,
    }).length > 0
  )
    return null;
  const providerThread = providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  // The thread's current selection receives the /compact, so it must still match this session.
  if (
    providerThread === undefined ||
    providerThread.id !== latestRun.providerThreadId ||
    providerThread.providerInstanceId !== thread.providerInstanceId ||
    latestRun.providerInstanceId !== thread.providerInstanceId
  )
    return null;
  const usages = providerTurns
    .filter((turn) => turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined)
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const usedTokens = usages[0]?.usedTokens ?? providerThread.contextUsage?.usedTokens ?? 0;
  const isNeon = isGeminiNeonModel(thread.modelSelection.model);
  const minContextTokens = isNeon ? NEON_AUTO_COMPACT_MIN_TOKENS : MIN_CONTEXT_TOKENS;
  if (usedTokens < minContextTokens) return null;
  const expiresAt = usages[0]?.promptCacheExpiresAt;
  if (expiresAt === undefined && isNeon) {
    const completedAtMs = DateTime.toEpochMillis(latestRun.completedAt);
    return {
      runId: latestRun.id,
      startMs: completedAtMs + NEON_IDLE_COMPACT_DELAY_MS,
      endMs: Number.POSITIVE_INFINITY,
    };
  }
  const endMs = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  if (!Number.isFinite(endMs) || nowMs >= endMs) return null;
  return { runId: latestRun.id, startMs: endMs - LEAD_MS, endMs };
}
