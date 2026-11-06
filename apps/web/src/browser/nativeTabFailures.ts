import type { EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

const GUARD_REFUSAL_CODES = new Set([-20, -111, -324]);
const failedServerUrls = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

const keyOf = (environmentId: EnvironmentId, tabId: string) =>
  JSON.stringify([environmentId, tabId]);

export function isGuardRefusal(code: number): boolean {
  return GUARD_REFUSAL_CODES.has(code);
}

export function recordNativeTabFailure(
  environmentId: EnvironmentId,
  tabId: string,
  serverUrl: string,
): void {
  const key = keyOf(environmentId, tabId);
  if (failedServerUrls.get(key) === serverUrl) return;
  failedServerUrls.set(key, serverUrl);
  version += 1;
  for (const listener of listeners) listener();
}

export function nativeTabFailed(
  environmentId: EnvironmentId,
  tabId: string,
  serverUrl: string,
): boolean {
  const key = keyOf(environmentId, tabId);
  const failed = failedServerUrls.get(key);
  if (failed === undefined) return false;
  if (failed === serverUrl) return true;
  failedServerUrls.delete(key);
  return false;
}

export function forgetNativeTabFailures(environmentId: EnvironmentId): void {
  for (const key of failedServerUrls.keys()) {
    if ((JSON.parse(key) as [string, string])[0] === environmentId) failedServerUrls.delete(key);
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
