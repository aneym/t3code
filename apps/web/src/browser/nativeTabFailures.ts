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
  return failedServerUrls.get(keyOf(environmentId, tabId)) === serverUrl;
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
