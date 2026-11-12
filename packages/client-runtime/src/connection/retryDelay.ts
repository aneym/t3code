const RETRY_MIN_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 300_000;
const OUTAGE_SHARE = 10;
export const BETTER_ROUTE_CHECK_INTERVAL_MS = 60_000;
// Each check of a dead route can wait out the full probe timeout, so a route
// that keeps failing is checked half as often each time, until the network
// changes and it may answer again.
const SILENT_ROUTE_BACKOFF_MAX_MS = 1_800_000;

export interface SilentRoute {
  readonly failures: number;
  readonly until: bigint;
}

export function retryDelayMs(outageMs: number, random: number): number {
  const ceiling = Math.min(
    RETRY_MAX_DELAY_MS,
    Math.max(RETRY_MIN_DELAY_MS, outageMs / OUTAGE_SHARE),
  );
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

export function backOffSilentRoute(previous: SilentRoute | undefined, now: bigint): SilentRoute {
  const failures = (previous?.failures ?? 0) + 1;
  const delayMs = Math.min(
    SILENT_ROUTE_BACKOFF_MAX_MS,
    BETTER_ROUTE_CHECK_INTERVAL_MS * 2 ** failures,
  );
  return { failures, until: now + BigInt(delayMs) * 1_000_000n };
}
