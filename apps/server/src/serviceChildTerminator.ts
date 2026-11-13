// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import type * as NodeChildProcess from "node:child_process";

import { sendMessage } from "./serviceLauncherMessages.ts";

const STOP_GRACE_MS = 75_000;

function waitForExit(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

export class ChildTerminator {
  readonly #stopDeadline = new AbortController();
  readonly #terminating = new Set<NodeChildProcess.ChildProcess>();
  #deadlineArmed = false;
  #beforeSignal: Promise<void> = Promise.resolve();
  readonly #stopOverIpc: boolean;

  /** Windows `kill()` is TerminateProcess, which skips the server's shutdown finalizers. */
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  constructor(stopOverIpc = process.platform === "win32") {
    this.#stopOverIpc = stopOverIpc;
  }

  startStopDeadline(onDeadline: () => void): void {
    if (this.#deadlineArmed) return;
    this.#deadlineArmed = true;
    const forceStop = () => {
      for (const child of this.#terminating) child.kill("SIGKILL");
      onDeadline();
    };
    this.#stopDeadline.signal.addEventListener("abort", forceStop, { once: true });
    setTimeout(() => this.#stopDeadline.abort(), STOP_GRACE_MS).unref();
  }

  holdSignalsUntil(ready: Promise<void>): Promise<void> {
    this.#beforeSignal = ready;
    return ready;
  }

  async terminate(
    child: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals = "SIGTERM",
    graceMs = STOP_GRACE_MS,
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    this.#terminating.add(child);
    const force = AbortSignal.any([
      this.#stopDeadline.signal,
      AbortSignal.timeout(Math.max(1, Math.ceil(graceMs))),
    ]);
    const kill = () => child.kill("SIGKILL");
    try {
      await this.#beforeSignal;
      if (this.#stopOverIpc)
        await sendMessage(child, { type: "stop" }).catch(() => child.kill(signal));
      else child.kill(signal);
      if (force.aborted) kill();
      else force.addEventListener("abort", kill, { once: true });
      await waitForExit(child);
    } finally {
      this.#terminating.delete(child);
      force.removeEventListener("abort", kill);
    }
  }
}
