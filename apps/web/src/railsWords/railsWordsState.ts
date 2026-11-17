import type { DesktopRailsWordsState } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

let current: DesktopRailsWordsState | null = null;
const listeners = new Set<() => void>();
let stopBridge: (() => void) | null = null;

function emit(next: DesktopRailsWordsState) {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  const bridge = window.desktopBridge?.railsWords;
  listeners.add(listener);
  if (bridge && stopBridge === null) {
    stopBridge = bridge.onState(emit);
    void bridge.getState().then(emit, () => undefined);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopBridge !== null) {
      stopBridge();
      stopBridge = null;
    }
  };
}

export function readRailsWordsState(): DesktopRailsWordsState | null {
  return current;
}

export function useRailsWordsState(): DesktopRailsWordsState | null {
  return useSyncExternalStore(subscribe, readRailsWordsState, () => null);
}

export function disconnectRailsWords(): Promise<void> {
  const bridge = window.desktopBridge?.railsWords;
  return bridge ? bridge.disconnect().then(emit) : Promise.resolve();
}
