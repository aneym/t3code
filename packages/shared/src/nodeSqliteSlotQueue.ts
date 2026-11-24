import * as Effect from "effect/Effect";

export interface SlotLease<Slot> {
  readonly slot: Slot;
  busy: boolean;
}

interface Waiter<Slot, Want> {
  readonly want: Want;
  entry: SlotLease<Slot> | undefined;
  wake: (() => void) | undefined;
}

export const makeSlotQueue = <Slot, Want>(
  slots: ReadonlyArray<Slot>,
  fits: (slot: Slot, want: Want) => boolean,
) => {
  const entries: ReadonlyArray<SlotLease<Slot>> = slots.map((slot) => ({ slot, busy: false }));
  const waiters: Array<Waiter<Slot, Want>> = [];
  const wakes: Array<() => void> = [];
  let waking = false;

  const releaseNow = (entry: SlotLease<Slot>) => {
    const index = waiters.findIndex((waiter) => fits(entry.slot, waiter.want));
    if (index === -1) {
      entry.busy = false;
      return;
    }
    const waiter = waiters.splice(index, 1)[0]!;
    waiter.entry = entry;
    if (waiter.wake === undefined) return;
    wakes.push(waiter.wake);
    if (waking) return;
    waking = true;
    try {
      for (let next = 0; next < wakes.length; next++) wakes[next]!();
    } finally {
      wakes.length = 0;
      waking = false;
    }
  };

  const release = (lease: SlotLease<Slot>) => Effect.sync(() => releaseNow(lease));

  const take = (
    want: Want,
    restoreWait: typeof Effect.interruptible,
  ): Effect.Effect<SlotLease<Slot>> =>
    Effect.suspend(() => {
      const free = entries.find((entry) => !entry.busy && fits(entry.slot, want));
      if (free !== undefined) {
        free.busy = true;
        return Effect.succeed(free);
      }
      const waiter: Waiter<Slot, Want> = { want, entry: undefined, wake: undefined };
      waiters.push(waiter);
      return restoreWait(
        Effect.callback<SlotLease<Slot>>((resume) => {
          if (waiter.entry !== undefined) return resume(Effect.succeed(waiter.entry));
          waiter.wake = () => resume(Effect.succeed(waiter.entry!));
        }),
      ).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            else if (waiter.entry !== undefined) releaseNow(waiter.entry);
          }),
        ),
      );
    });

  return { take, release };
};
