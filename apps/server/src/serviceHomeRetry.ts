// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as NodeTimers from "node:timers";

import { freeOwnedHome, homeStarted } from "./serviceHomeReclaim.ts";

const POLL_MS = 5_000;

export class HomeRetry {
  #delay = POLL_MS;
  #at = 0;
  readonly #baseDir: string;
  readonly #start: () => Promise<void>;
  readonly #fail: (cause: unknown) => void;
  #timer: ReturnType<typeof NodeTimers.setTimeout> | undefined;

  constructor(baseDir: string, start: () => Promise<void>, fail: (cause: unknown) => void) {
    this.#baseDir = baseDir;
    this.#start = start;
    this.#fail = fail;
  }

  clear(): void {
    NodeTimers.clearTimeout(this.#timer);
  }

  async run(acquire: boolean): Promise<boolean> {
    const delay = await this.retry(acquire);
    if (delay === undefined) {
      await this.#start();
      return true;
    }
    this.#timer = NodeTimers.setTimeout(() => {
      void this.run(true).catch(this.#fail);
    }, delay);
    return false;
  }

  reset(): void {
    this.#delay = POLL_MS;
    this.#at = 0;
  }

  watch(
    child: {
      readonly pid?: number | undefined;
      once(event: "exit", listener: () => void): unknown;
    },
    current: () => boolean,
  ): void {
    if (this.#delay === POLL_MS) return;
    const ready = NodeTimers.setInterval(() => {
      void homeStarted(this.#baseDir, child.pid ?? 0).then((started) => {
        if (!current() || !started) return;
        this.reset();
        NodeTimers.clearInterval(ready);
      });
    }, POLL_MS);
    child.once("exit", () => NodeTimers.clearInterval(ready));
  }

  async retry(acquire: boolean): Promise<number | undefined> {
    const home = await freeOwnedHome(this.#baseDir);
    if (home === "owned") {
      this.reset();
    } else if (home === "reclaimed" || (acquire && performance.now() >= this.#at)) {
      if (home === "reclaimed") this.reset();
      return undefined;
    } else if (!acquire) {
      this.#at = performance.now() + this.#delay;
      this.#delay = Math.min(this.#delay * 2, 300_000);
    }
    return home === "free" ? Math.min(POLL_MS, Math.max(0, this.#at - performance.now())) : POLL_MS;
  }
}
