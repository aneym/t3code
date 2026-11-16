// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import type * as NodeChildProcess from "node:child_process";

import type { ServiceLauncherParentMessage } from "./cloud/serviceProtocol.ts";

export function sendMessage(
  child: NodeChildProcess.ChildProcess,
  message: ServiceLauncherParentMessage,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected || child.send === undefined) {
      reject(new Error("service child IPC is disconnected."));
      return;
    }
    child.send(message, (error) => (error === null ? resolve() : reject(error)));
  });
}

function exited(child: NodeChildProcess.ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (exited(child)) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

export async function signalChild(
  child: NodeChildProcess.ChildProcess,
  signal: NodeJS.Signals,
  overIpc: boolean,
): Promise<void> {
  if (exited(child)) return;
  if (overIpc) {
    await sendMessage(child, { type: "stop" }).catch(() => child.kill(signal));
  } else {
    child.kill(signal);
  }
}

export async function terminateChild(
  child: NodeChildProcess.ChildProcess,
  input: {
    readonly signal: NodeJS.Signals;
    readonly overIpc: boolean;
    readonly waitMs: number;
    readonly skipDrain: boolean;
  },
): Promise<void> {
  if (exited(child)) return;
  await signalChild(child, input.signal, input.overIpc);
  if (input.skipDrain) await signalChild(child, input.signal, input.overIpc);
  const force = setTimeout(() => child.kill("SIGKILL"), input.waitMs);
  try {
    await waitForExit(child);
  } finally {
    clearTimeout(force);
  }
}
