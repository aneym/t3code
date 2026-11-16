type SignalListener = (signal: NodeJS.Signals) => void;

let runtimeListeners: ReadonlyArray<SignalListener> | null = null;
const deferredListeners = new Set<() => void>();
let drainer: (() => void) | null = null;
let requested = false;
let proceeded = false;

export function takeOverStopSignal(): void {
  if (runtimeListeners !== null) return;
  runtimeListeners = process.listeners("SIGTERM") as Array<SignalListener>;
  for (const listener of runtimeListeners) process.off("SIGTERM", listener);
  process.on("SIGTERM", requestStop);
}

export function requestStop(): void {
  if (requested || drainer === null) {
    proceedStop();
    return;
  }
  requested = true;
  drainer();
}

export function proceedStop(): void {
  if (proceeded) return;
  proceeded = true;
  for (const listener of deferredListeners) listener();
  for (const listener of runtimeListeners ?? []) listener("SIGTERM");
}

export function setStopDrainer(next: (() => void) | null): void {
  drainer = next;
}

export function onShutdownSignals(listener: () => void): () => void {
  process.on("SIGINT", listener);
  if (runtimeListeners === null) process.on("SIGTERM", listener);
  else deferredListeners.add(listener);
  return () => {
    process.off("SIGINT", listener);
    process.off("SIGTERM", listener);
    deferredListeners.delete(listener);
  };
}
