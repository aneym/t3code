// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as NodeChildProcess from "node:child_process";
import type * as NodeNet from "node:net";

type SignalListener = (signal: NodeJS.Signals) => void;

const STOP_NOW_DEADLINE_MS = 1_500;
const STOP_NOW_WATCHDOG_SECONDS = "2";
const STOP_NOW_WATCHDOG_SCRIPT =
  'exec 3<&0; sleep "$2" & s=$!; { read -r _ <&3; kill "$s" 2>/dev/null; } & wait "$s" && kill -KILL "$1"';

let runtimeListeners: ReadonlyArray<SignalListener> | null = null;
const deferredListeners = new Set<() => void>();
const stopNowListeners = new Set<SignalListener>();
let drainer: (() => void) | null = null;
let requested = false;
let proceeded = false;
let stoppingNow = false;

export function takeOverStopSignal(): void {
  if (runtimeListeners !== null) return;
  runtimeListeners = process.listeners("SIGTERM") as Array<SignalListener>;
  for (const listener of runtimeListeners) process.off("SIGTERM", listener);
  process.on("SIGTERM", requestStop);
}

export function requestStop(): void {
  if (requested || proceeded) stopNow();
  if (requested || drainer === null) {
    proceedStop();
    return;
  }
  requested = true;
  drainer();
}

export function stopRequested(): boolean {
  return requested;
}

export function proceedStop(): void {
  if (proceeded) return;
  proceeded = true;
  for (const listener of deferredListeners) listener();
  withoutSelfStopSignal(() => {
    for (const listener of runtimeListeners ?? []) listener("SIGTERM");
  });
}

function withoutSelfStopSignal(run: () => void): void {
  const kill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === process.pid && signal === "SIGTERM") return true;
    return kill.call(process, pid, signal);
  };
  try {
    run();
  } finally {
    process.kill = kill;
  }
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

export function onStopNow(listener: SignalListener): () => void {
  stopNowListeners.add(listener);
  return () => {
    stopNowListeners.delete(listener);
  };
}

function stopNow(): void {
  if (stoppingNow) return;
  stoppingNow = true;
  notifyStopNow("SIGTERM");
  setTimeout(forceStop, STOP_NOW_DEADLINE_MS).unref();
  try {
    const watchdog = NodeChildProcess.spawn(
      "/bin/sh",
      [
        "-c",
        STOP_NOW_WATCHDOG_SCRIPT,
        "t3-stop-now",
        String(process.pid),
        STOP_NOW_WATCHDOG_SECONDS,
      ],
      { stdio: ["pipe", "ignore", "ignore"], detached: true },
    );
    watchdog.on("error", () => undefined);
    watchdog.stdin?.on("error", () => undefined);
    watchdog.unref();
    (watchdog.stdin as NodeNet.Socket | null)?.unref();
  } catch {}
}

function notifyStopNow(signal: NodeJS.Signals): void {
  for (const listener of stopNowListeners) {
    try {
      listener(signal);
    } catch {}
  }
}

function forceStop(): void {
  notifyStopNow("SIGKILL");
  process.stderr.write("Server shutdown passed its stop-now deadline; ending the process.\n");
  process.kill(process.pid, "SIGKILL");
}
