import { minuteTick } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";

const stayStill = () => () => {};

export function useNowMinute(active = true): string {
  return useSyncExternalStore(
    active ? minuteTick.subscribe : stayStill,
    minuteTick.getSnapshot,
    minuteTick.getSnapshot,
  );
}
