import * as DateTime from "effect/DateTime";

const POOL_EXHAUSTED =
  /\b(no_accounts(_available)?|no_eligible_accounts|no_available_\w+_accounts|no_gemini_account|quota_exhausted|usage_limit_reached|x-agent-lb-pool-exhausted)\b|account in this pool is out of quota/i;
const EARLIEST_RESET = /earliest reset (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/;
const RESETS_AT_EPOCH = /"?resets_at"?\s*[:=]\s*(\d{9,11}(?:\.\d+)?)/;
const RESETS_IN = /resets? (?:in|after) ((?:\d+\s*[hms]\s*)+)/i;
const DURATION_PART = /(\d+)\s*([hms])/g;
const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };

export const isPoolExhaustedText = (text: string | null | undefined): boolean =>
  text != null && POOL_EXHAUSTED.test(text);

export function poolResetAt(text: string, nowMs: number): string | undefined {
  const earliest = EARLIEST_RESET.exec(text);
  if (earliest !== null) return `${earliest[1]}T${earliest[2]}:00.000Z`;
  const epoch = RESETS_AT_EPOCH.exec(text);
  if (epoch !== null) return DateTime.formatIso(DateTime.makeUnsafe(Number(epoch[1]) * 1_000));
  const relative = RESETS_IN.exec(text);
  if (relative === null) return undefined;
  let ms = 0;
  for (const [, amount, unit] of relative[1]!.matchAll(DURATION_PART)) {
    ms += Number(amount) * UNIT_MS[unit!]!;
  }
  return ms === 0 ? undefined : DateTime.formatIso(DateTime.makeUnsafe(nowMs + ms));
}
