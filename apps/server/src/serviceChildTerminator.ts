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
  #beforeSignal: Promise<void> = Promise.resolve();

  startStopDeadline(onDeadline: () => void, beforeSignal: () => Promise<void>): Promise<void> {
    const forceStop = () => {
      for (const child of this.#terminating) child.kill("SIGKILL");
      onDeadline();
    };
    this.#stopDeadline.signal.addEventListener("abort", forceStop, { once: true });
    setTimeout(() => this.#stopDeadline.abort(), STOP_GRACE_MS).unref();
    this.#beforeSignal = beforeSignal();
    return this.#beforeSignal;
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
