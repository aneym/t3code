// @effect-diagnostics nodeBuiltinImport:off -- The native launcher bounds relinquished child lifetimes.
// @effect-diagnostics globalTimers:off -- Exit deadlines must not wait on a child message queue.
import type * as NodeChildProcess from "node:child_process";
import type { ChildTerminator } from "./serviceChildTerminator.ts";

export class ServiceLauncherExitDeadline {
  readonly #timers = new Map<NodeChildProcess.ChildProcess, NodeJS.Timeout>();

  arm(child: NodeChildProcess.ChildProcess, budget: number, terminator: ChildTerminator): void {
    this.cancel(child);
    const timer = setTimeout(
      () => {
        this.#timers.delete(child);
        void terminator
          .terminate(child, "SIGTERM", Math.max(1, Math.min(1000, budget / 8)))
          .catch(() => undefined);
      },
      Math.max(1, budget / 2 + Math.min(500, budget / 10)),
    );
    timer.unref();
    this.#timers.set(child, timer);
    child.once("exit", () => this.cancel(child));
  }

  cancel(child: NodeChildProcess.ChildProcess): void {
    clearTimeout(this.#timers.get(child));
    this.#timers.delete(child);
  }

  clear(): void {
    for (const child of this.#timers.keys()) this.cancel(child);
  }
}
