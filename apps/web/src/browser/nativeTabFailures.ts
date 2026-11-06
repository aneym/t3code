import type { EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

const ERR_BLOCKED_BY_CLIENT = -20;
const failedUrls = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
let version = 0;

const keyOf = (environmentId: EnvironmentId, tabId: string) =>
  JSON.stringify([environmentId, tabId]);
const normalized = (url: string) => URL.parse(url)?.href ?? url;

export function isGuardRefusal(code: number): boolean {
  return code === ERR_BLOCKED_BY_CLIENT;
}

export function recordNativeTabFailure(
  environmentId: EnvironmentId,
  tabId: string,
  urls: ReadonlyArray<string>,
): void {
  const key = keyOf(environmentId, tabId);
  const previous = failedUrls.get(key) ?? new Set<string>();
  const next = new Set([...previous, ...urls.map(normalized)]);
  if (next.size === previous.size) return;
  failedUrls.set(key, next);
  version += 1;
  for (const listener of listeners) listener();
}

export function nativeTabFailed(
  environmentId: EnvironmentId,
  tabId: string,
  serverUrl: string,
): boolean {
  const key = keyOf(environmentId, tabId);
  const failed = failedUrls.get(key);
  if (failed === undefined) return false;
  if (failed.has(normalized(serverUrl))) return true;
  failedUrls.delete(key);
  return false;
}

export function forgetNativeTabFailures(environmentId: EnvironmentId): void {
  for (const key of failedUrls.keys()) {
    if ((JSON.parse(key) as [string, string])[0] === environmentId) failedUrls.delete(key);
  }
}

export function subscribeNativeTabFailures(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useNativeTabFailures(): number {
  return useSyncExternalStore(subscribeNativeTabFailures, () => version);
}
