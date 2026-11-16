export const RESTART_DRAIN_ENV = "T3CODE_RESTART_DRAIN_SECONDS";
const DEFAULT_DRAIN_SECONDS = 60;
const MAX_DRAIN_SECONDS = 30 * 60;
const RESTART_DRAIN_GRACE_SECONDS = 15;
const STOP_MARGIN_SECONDS = 15;
const MIN_STOP_TIMEOUT_SECONDS = 90;

export function restartDrainSeconds(value: string | undefined): number {
  const trimmed = value?.trim() ?? "";
  const parsed = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(parsed) || parsed < 0) return DEFAULT_DRAIN_SECONDS;
  return Math.min(MAX_DRAIN_SECONDS, Math.floor(parsed));
}

export function restartStopWaitMs(drainSeconds: number): number {
  return (drainSeconds + RESTART_DRAIN_GRACE_SECONDS) * 1000;
}

export function serviceStopTimeoutSeconds(drainSeconds: number): number {
  return Math.max(
    MIN_STOP_TIMEOUT_SECONDS,
    drainSeconds + RESTART_DRAIN_GRACE_SECONDS + STOP_MARGIN_SECONDS,
  );
}

export const SERVICE_STOP_STEP_MINUTES =
  Math.ceil((MAX_DRAIN_SECONDS + RESTART_DRAIN_GRACE_SECONDS + STOP_MARGIN_SECONDS) / 60) + 1;

export const DEFAULT_RESTART_STOP_WAIT_MS = restartStopWaitMs(DEFAULT_DRAIN_SECONDS);
