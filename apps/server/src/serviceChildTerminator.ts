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

  startStopDeadline(): void {
    setTimeout(() => this.#stopDeadline.abort(), STOP_GRACE_MS).unref();
  }

  get stopDeadlinePassed(): boolean {
    return this.#stopDeadline.signal.aborted;
  }

  async terminate(
    child: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals = "SIGTERM",
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    const force = AbortSignal.any([this.#stopDeadline.signal, AbortSignal.timeout(STOP_GRACE_MS)]);
    const kill = () => child.kill("SIGKILL");
    if (force.aborted) kill();
    else force.addEventListener("abort", kill, { once: true });
    try {
      await waitForExit(child);
    } finally {
      force.removeEventListener("abort", kill);
    }
  }
}
