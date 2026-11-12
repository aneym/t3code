import { useSyncExternalStore } from "react";

let peeked: string | null = null;
const listeners = new Set<() => void>();

export function setEmbedLivePeek(turn: string | null): void {
  peeked = turn;
  for (const listener of listeners) listener();
}

export function useEmbedLivePeek(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => peeked,
    () => null,
  );
}
