const STATUS_SHOW_DELAY_MS = 400;
const STATUS_MIN_VISIBLE_MS = 400;

export interface DelayedStatusTiming {
  readonly showDelayMs?: number;
  readonly minVisibleMs?: number;
}

/**
 * A status shows only after it has stayed set for a moment, then stays shown
 * for a minimum time so a quick flicker never flashes on screen.
 * `deadlinePassed` tells whether `delayedStatusDeadline(state)` has been reached.
 */
export type DelayedStatusState<A> =
  | { readonly phase: "idle"; readonly key: string }
  | {
      readonly phase: "pending";
      readonly key: string;
      readonly value: A;
      readonly showDelayMs: number;
      readonly showAt: number;
    }
  | {
      readonly phase: "shown";
      readonly key: string;
      readonly value: A;
      readonly holdUntil: number;
    };

export interface DelayedStatusInput<A> {
  readonly key: string;
  /** Compared by identity, so use strings or other stable values. */
  readonly value: A | null;
  readonly deadlinePassed: boolean;
  readonly timing?: DelayedStatusTiming;
}

/**
 * Returns `state` itself when nothing changes, so it can run on every render.
 * `now` is read only to stamp a new deadline; it is a function so a memoizing
 * caller (the React Compiler) cannot cache a stale clock reading.
 */
export function stepDelayedStatus<A>(
  state: DelayedStatusState<A> | null,
  { key, value, deadlinePassed, timing: inputTiming }: DelayedStatusInput<A>,
  now: () => number,
): DelayedStatusState<A> {
  const idle = (): DelayedStatusState<A> => ({ phase: "idle", key });
  const showDelayMs = inputTiming?.showDelayMs ?? STATUS_SHOW_DELAY_MS;
  const pending = (pendingValue: A): DelayedStatusState<A> =>
    showDelayMs <= 0
      ? shown(pendingValue)
      : {
          phase: "pending",
          key,
          value: pendingValue,
          showDelayMs,
          showAt: now() + showDelayMs,
        };
  const shown = (shownValue: A): DelayedStatusState<A> => ({
    phase: "shown",
    key,
    value: shownValue,
    holdUntil: now() + (inputTiming?.minVisibleMs ?? STATUS_MIN_VISIBLE_MS),
  });

  if (state === null || state.key !== key) return value === null ? idle() : pending(value);
  switch (state.phase) {
    case "idle":
      return value === null ? state : pending(value);
    case "pending":
      if (value === null) return idle();
      if (showDelayMs <= 0) return shown(value);
      if (deadlinePassed) return shown(value);
      if (value !== state.value || showDelayMs !== state.showDelayMs) {
        const showAt = Math.min(state.showAt, now() + showDelayMs);
        return { phase: "pending", key, value, showDelayMs, showAt };
      }
      return state;
    case "shown":
      if (value === null) return deadlinePassed ? idle() : state;
      return value === state.value ? state : shown(value);
  }
}

export function delayedStatusDeadline<A>(state: DelayedStatusState<A>): number | null {
  switch (state.phase) {
    case "idle":
      return null;
    case "pending":
      return state.showAt;
    case "shown":
      return state.holdUntil;
  }
}

export function shownDelayedStatus<A>(state: DelayedStatusState<A>, key: string): A | null {
  return state.phase === "shown" && state.key === key ? state.value : null;
}
