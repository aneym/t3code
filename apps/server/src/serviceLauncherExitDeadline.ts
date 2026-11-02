// @effect-diagnostics nodeBuiltinImport:off -- The native launcher bounds relinquished child lifetimes.
// @effect-diagnostics globalTimers:off -- Exit deadlines must not wait on a child message queue.
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import * as NodeTimers from "node:timers";
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

declare const __T3CODE_PRODUCTION_BUILD__: boolean;

const PREPARED_TIMEOUT_MS = 30 * 60_000;
const RECOVERY_TIMEOUT_MS = 10 * 60_000;
let recoveryTimer: NodeJS.Timeout | undefined;

function serviceDeadlineMs(
  fallback: number,
  key: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): number {
  if (typeof __T3CODE_PRODUCTION_BUILD__ !== "undefined" || environment.NODE_ENV !== "test")
    return fallback;
  const override = Number(environment[key]);
  return Number.isSafeInteger(override) && override > 0 && override <= fallback
    ? override
    : fallback;
}

export function armServiceRecoveryDeadline(): void {
  clearServiceRecoveryDeadline();
  const timeout = serviceDeadlineMs(
    RECOVERY_TIMEOUT_MS,
    "T3CODE_TEST_RECOVERY_TIMEOUT_MS",
    NodeProcess.env,
  );
  recoveryTimer = NodeTimers.setTimeout(() => {
    try {
      NodeFS.writeSync(
        2,
        `Warm hot-swap recovery deadline exceeded (${timeout}ms after commit); exiting for rollback.\n`,
      );
    } finally {
      NodeProcess.kill(NodeProcess.pid, "SIGKILL");
    }
  }, timeout);
  recoveryTimer.unref();
}

export function clearServiceRecoveryDeadline(): void {
  NodeTimers.clearTimeout(recoveryTimer);
  recoveryTimer = undefined;
}

export const servicePreparedDeadlineMs = (environment: Readonly<NodeJS.ProcessEnv>) =>
  serviceDeadlineMs(PREPARED_TIMEOUT_MS, "T3CODE_TEST_PREPARED_TIMEOUT_MS", environment);
