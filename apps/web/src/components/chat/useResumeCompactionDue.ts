import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import { useNowAfter } from "../../hooks/useDeadline";
import {
  CLAUDE_RESUME_COMPACTION_FALLBACK_MS,
  shouldOfferResumeCompaction,
} from "./ContextWindowMeter.logic";

export function useResumeCompactionDue(
  provider: string | null | undefined,
  contextWindow: ContextWindowSnapshot | null,
  promptCacheTtlMs: number | undefined,
): boolean {
  const updatedAtMs = Date.parse(contextWindow?.updatedAt ?? "");
  const nowMs = useNowAfter(
    Number.isFinite(updatedAtMs)
      ? updatedAtMs + (promptCacheTtlMs ?? CLAUDE_RESUME_COMPACTION_FALLBACK_MS)
      : null,
  );
  return shouldOfferResumeCompaction({
    provider,
    usedTokens: contextWindow?.usedTokens,
    updatedAt: contextWindow?.updatedAt,
    promptCacheTtlMs,
    now: new Date(nowMs).toISOString(),
  });
}
