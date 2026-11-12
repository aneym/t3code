// @effect-diagnostics globalTimers:off - The grace timer runs in web and native clients, outside an Effect runtime.
import type { EnvironmentId } from "@t3tools/contracts";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";

const UNREACHABLE_ENVIRONMENT_GRACE_MS = 2 * 60 * 1_000;

export interface EnvironmentReachabilityInput {
  readonly environmentId: EnvironmentId;
  readonly phase: EnvironmentConnectionPhase;
  readonly shellIsLive: boolean;
}

const EMPTY: ReadonlySet<EnvironmentId> = new Set();

export function createUnreachableEnvironmentTracker(graceMs = UNREACHABLE_ENVIRONMENT_GRACE_MS) {
  const answered = new Set<EnvironmentId>();
  const retryingSince = new Map<EnvironmentId, number>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let version = 0;
  let previous = EMPTY;
  const now = () => {
    // @effect-diagnostics-next-line globalDate:off - The grace is wall-clock time shared by web and native clients.
    return Date.now();
  };
  const schedule = (at: number) => {
    clearTimeout(timer);
    timer = undefined;
    let next = Infinity;
    for (const [environmentId, since] of retryingSince) {
      if (answered.has(environmentId) && since + graceMs > at) {
        next = Math.min(next, since + graceMs);
      }
    }
    if (next === Infinity) return;
    timer = setTimeout(() => {
      timer = undefined;
      version++;
      for (const listener of listeners) listener();
    }, next - at);
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => version,
    observe(environments: ReadonlyArray<EnvironmentReachabilityInput>): ReadonlySet<EnvironmentId> {
      const at = now();
      const next = new Set<EnvironmentId>();
      const present = new Set<EnvironmentId>();
      for (const { environmentId, phase, shellIsLive } of environments) {
        present.add(environmentId);
        if (phase === "connected" && shellIsLive) answered.add(environmentId);
        if (phase === "error" || phase === "unsupported") {
          next.add(environmentId);
          retryingSince.delete(environmentId);
          continue;
        }
        if (phase !== "reconnecting") {
          retryingSince.delete(environmentId);
          continue;
        }
        const since = retryingSince.get(environmentId) ?? at;
        retryingSince.set(environmentId, since);
        if (!answered.has(environmentId) || at - since >= graceMs) next.add(environmentId);
      }
      for (const environmentId of retryingSince.keys()) {
        if (!present.has(environmentId)) retryingSince.delete(environmentId);
      }
      schedule(at);
      if (next.size === previous.size && [...next].every((id) => previous.has(id))) {
        return previous;
      }
      previous = next.size === 0 ? EMPTY : next;
      return previous;
    },
  };
}
