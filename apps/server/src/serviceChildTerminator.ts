// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import type * as NodeChildProcess from "node:child_process";

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
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    this.#terminating.add(child);
    const force = AbortSignal.any([this.#stopDeadline.signal, AbortSignal.timeout(STOP_GRACE_MS)]);
    const kill = () => child.kill("SIGKILL");
    try {
      await this.#beforeSignal;
      child.kill(signal);
      if (force.aborted) kill();
      else force.addEventListener("abort", kill, { once: true });
      await waitForExit(child);
    } finally {
      this.#terminating.delete(child);
      force.removeEventListener("abort", kill);
    }
  }
}
