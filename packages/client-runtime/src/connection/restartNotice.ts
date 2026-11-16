const ANNOUNCED_RESTART_WINDOW_MS = 60_000;
const ANNOUNCED_RESTART_RETRY_MS = 500;

const announcedAt = new Map<string, number>();
const listeners = new Set<() => void>();

export function noteRestartAnnounced(environmentId: string, at: number): void {
  announcedAt.set(environmentId, at);
  for (const listener of listeners) listener();
}

export function noteServerStarting(
  environmentId: string,
  failure: { readonly _tag: string; readonly httpStatus?: number; readonly via?: string },
  at: number,
): void {
  if (failure._tag !== "ConnectionTransientError" || failure.httpStatus !== 503) return;
  if (failure.via === "relay") return;
  const prior = announcedAt.get(environmentId);
  if (prior !== undefined && at - prior < 2 * ANNOUNCED_RESTART_WINDOW_MS) return;
  noteRestartAnnounced(environmentId, at);
}

function restartAnnouncedSince(environmentId: string, now: number): number | null {
  const at = announcedAt.get(environmentId);
  return at !== undefined && now - at < ANNOUNCED_RESTART_WINDOW_MS ? at : null;
}

export function announcedRestartRetryDelayMs(environmentId: string, now: number): number | null {
  return restartAnnouncedSince(environmentId, now) === null ? null : ANNOUNCED_RESTART_RETRY_MS;
}

export function restartAnnouncementDeadline(environmentId: string): number | null {
  const at = announcedAt.get(environmentId);
  return at === undefined ? null : at + ANNOUNCED_RESTART_WINDOW_MS;
}

export function subscribeRestartNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
