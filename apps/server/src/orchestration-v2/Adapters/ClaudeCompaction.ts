import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

const CLAUDE_AUTO_COMPACT_RESERVE_TOKENS = 33_000;

export const CLAUDE_COMPACTION_FAILURE_CAP = 2;

export function claudeAutoCompactThreshold(autoCompactWindow: string, maxTokens: number | null) {
  const windowTokens = Number(autoCompactWindow);
  return windowTokens > 0 && (maxTokens === null || windowTokens < maxTokens)
    ? { autoCompactThreshold: windowTokens - CLAUDE_AUTO_COMPACT_RESERVE_TOKENS }
    : {};
}

export function claudeCompactionFailed(
  previous: { readonly count: number } | null,
  message: string | undefined,
) {
  return { message, count: (previous?.count ?? 0) + 1 };
}

export function claudeCompactionCapFailure(error: string | undefined) {
  const reason = error === undefined || error.trim() === "" ? "" : ` (${error.trim()})`;
  return makeProviderFailure({
    class: "provider_error",
    code: "compaction_failed",
    message: `Context compaction failed ${CLAUDE_COMPACTION_FAILURE_CAP} times in a row${reason}. The run stopped so queued messages can start; send /compact or start a new thread if it keeps failing.`,
  });
}
