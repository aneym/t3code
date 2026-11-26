import * as DateTime from "effect/DateTime";

const POOL_EXHAUSTED =
  /\b(usage_limit_reached|x-agent-lb-pool-exhausted)\b|account in this pool is out of quota/i;
const CLAUDE_POOL =
  /\b\d+ (?:Anthropic|GLM|Kimi|OpenRouter) accounts? exist, but none are selectable for [\w./-]+/i;
const NO_ACCOUNTS =
  /\b(no_accounts(?:_available)?|no_eligible_accounts|no_available_\w+_accounts|no_gemini_account)\b/i;
const EARLIEST_RESET = /earliest reset (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/;
const RESETS_AT_EPOCH = /"?resets_at"?\s*[:=]\s*(\d{9,11}(?:\.\d+)?)/;
const RESET_TIMESTAMP =
  /(?:limits reset at|quotaResetTimeStamp:)\s*(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/i;
const RESETS_IN = /resets? (?:in|after) ((?:\d+\s*[hms]\s*)+)/i;
const DURATION_PART = /(\d+)\s*([hms])/g;
const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };

export function poolFailureDetail(text: string, status: number | null, nowMs: number) {
  const httpStatus =
    status ??
    Number(/\b(?:HTTP|status|Error:?|Request rejected \()\s*(429|503)\b/i.exec(text)?.[1]);
  const resetAt = poolResetAt(text, nowMs);
  const retryAfter = /\bretry-after["']?\s*[:=]\s*["']?(\d+)/i.exec(text)?.[1];
  const longReset = resetAt !== undefined && Date.parse(resetAt) - nowMs > 300_000;
  const retryable503 =
    httpStatus === 503 &&
    ((retryAfter !== undefined && Number(retryAfter) <= 300) ||
      (resetAt !== undefined && !longReset));
  if (
    retryable503 ||
    (!POOL_EXHAUSTED.test(text) &&
      !(CLAUDE_POOL.test(text) && longReset) &&
      !(httpStatus === 503 && longReset && NO_ACCOUNTS.test(text)))
  )
    return undefined;
  const message = text
    .replace(/,?\s*\\?["']diagnostics\\?["']\s*:[^\r\n]*/gi, "")
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[REDACTED]")
    .replace(
      /(\\?["']?\b(?:id|account[_ -]?ids?)\b\\?["']?\s*[:=]\s*)(?:\\?"[^"\\]*\\?"|'[^']*'|\[[^\]]*\]|[\w-]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-f0-9]{24,}|(?:acct|account)[_-][\w-]{10,})\b/gi,
      "[REDACTED]",
    );
  return {
    message: `${resetAt === undefined || RESET_TIMESTAMP.test(message) ? "" : `Limits reset at ${resetAt}.\n`}${message}`,
    resetAt,
  };
}

export function poolResetAt(text: string, nowMs: number): string | undefined {
  const epoch = RESETS_AT_EPOCH.exec(text);
  if (epoch !== null) return DateTime.formatIso(DateTime.makeUnsafe(Number(epoch[1]) * 1_000));
  const timestamp = RESET_TIMESTAMP.exec(text)?.[1];
  if (timestamp !== undefined && Number.isFinite(Date.parse(timestamp))) {
    return DateTime.formatIso(DateTime.makeUnsafe(timestamp));
  }
  const earliest = EARLIEST_RESET.exec(text);
  if (earliest !== null) return `${earliest[1]}T${earliest[2]}:00.000Z`;
  const relative = RESETS_IN.exec(text);
  if (relative === null) return undefined;
  let ms = 0;
  for (const [, amount, unit] of relative[1]!.matchAll(DURATION_PART)) {
    ms += Number(amount) * UNIT_MS[unit!]!;
  }
  const resetAt = nowMs + ms;
  return ms > 0 && Math.abs(resetAt) <= 8.64e15
    ? DateTime.formatIso(DateTime.makeUnsafe(resetAt))
    : undefined;
}
