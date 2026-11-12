import type { EnvironmentId } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

const epochs = new Map<EnvironmentId, number>();
const stamps = new WeakMap<object, number>();

const currentEpoch = (environmentId: EnvironmentId) => epochs.get(environmentId) ?? 0;

export function admitsPreviewValue(environmentId: EnvironmentId, value: unknown): boolean {
  if (!Predicate.isObject(value)) return true;
  const stamp = stamps.get(value);
  if (stamp !== undefined) return stamp === currentEpoch(environmentId);
  stamps.set(value, currentEpoch(environmentId));
  return true;
}

export function advancePreviewTrustEpoch(
  environmentId: EnvironmentId,
  cached: Iterable<unknown>,
): void {
  const previous = currentEpoch(environmentId);
  for (const value of cached) {
    if (Predicate.isObject(value) && !stamps.has(value)) stamps.set(value, previous);
  }
  epochs.set(environmentId, previous + 1);
}
