// @effect-diagnostics globalTimers:off
// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { freeOwnedHome, homeStarted } from "./serviceHomeReclaim.ts";
import * as NodeTimers from "node:timers";

import { ChildTerminator } from "./serviceChildTerminator.ts";
import { killCopyHelpers } from "./serviceDatabaseCopy.ts";

const OWNED_RETRY_MAX_MS = 30_000;
// Match contracts' SERVER_EXIT_CODE_STATE_DIR_OWNED without depending on Effect.
const STATE_DIR_OWNED_EXIT_CODE = 78;
const UNSAFE_RESTORE_MARKER = ".restore-unsafe";

async function pathExists(target: string): Promise<boolean> {
  try {
    await NodeFSP.access(target);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

// Mark before live writes so recovery cannot boot a partial restore.
export async function markDatabaseBackup(backupDir: string, marker: string): Promise<void> {
  const markerPath = NodePath.join(backupDir, marker);
  if (!(await pathExists(markerPath))) {
    const handle = await NodeFSP.open(markerPath, "wx", 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await NodeFSP.open(backupDir, "r");
    try {
      await directory.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    } finally {
      await directory.close();
    }
  }
}

export async function databaseBackupRestoreUnsafe(
  backupDir: string,
  log = false,
): Promise<boolean> {
  const unsafe = await pathExists(NodePath.join(backupDir, UNSAFE_RESTORE_MARKER));
  if (unsafe && log) {
    process.stderr.write(
      `[service-launcher] Automatic restore refused; backup retained at ${backupDir}.\n`,
    );
  }
  return unsafe;
}

export class ServiceRestartGuards {
  readonly terminator = new ChildTerminator();
  failure: Error | undefined;
  #ownedRetries = 0;
  #unclassifiedRetries = 0;
  #waiting = false;

  startStopDeadline(onDeadline: () => NodeChildProcess.ChildProcess | undefined): void {
    this.terminator.startStopDeadline(() => {
      onDeadline()?.kill("SIGKILL");
      killCopyHelpers();
      if (this.failure !== undefined) {
        process.stderr.write(`[service-launcher] ${this.failure.message}\n`);
      }
      process.stderr.write(
        "[service-launcher] Stop deadline passed; exiting without the server.\n",
      );
      process.removeAllListeners("SIGTERM");
      process.kill(process.pid, "SIGTERM");
    });
  }

  resetRetries(): void {
    this.#ownedRetries = this.#unclassifiedRetries = 0;
  }

  async retryAfterExit(
    code: number | null,
    confirmed: boolean,
    backupDir?: string,
    baseDir?: string,
  ): Promise<number | "exhausted" | undefined> {
    if (code !== STATE_DIR_OWNED_EXIT_CODE) {
      this.resetRetries();
      return undefined;
    }
    if (backupDir !== undefined && (await pathExists(backupDir))) {
      await markDatabaseBackup(backupDir, UNSAFE_RESTORE_MARKER);
    }
    if (baseDir !== undefined) {
      const home = await freeOwnedHome(baseDir);
      this.#waiting = home === "owned";
      if (home !== "free") {
        this.resetRetries();
        return home === "reclaimed" ? 0 : 5_000;
      }
    }
    if (!confirmed && this.#unclassifiedRetries++ >= 5) {
      this.resetRetries();
      return "exhausted";
    }
    if (confirmed) this.#unclassifiedRetries = 0;
    if (this.#ownedRetries === 0) {
      process.stderr.write(
        confirmed
          ? "[service-launcher] Another T3 Code server owns this T3 home. Retrying until it stops.\n"
          : "[service-launcher] Unclassified exit 78; retrying up to 5 times.\n",
      );
    }
    return Math.min(
      (confirmed ? 5_000 : 1_000) * 2 ** this.#ownedRetries++,
      confirmed ? 300_000 : OWNED_RETRY_MAX_MS,
    );
  }

  async homeAvailable(baseDir: string): Promise<boolean> {
    if (!this.#waiting) return true;
    const home = await freeOwnedHome(baseDir);
    if (home === "owned") return false;
    this.#waiting = false;
    this.resetRetries();
    return true;
  }

  watch(baseDir: string, child: NodeChildProcess.ChildProcess, current: () => boolean): void {
    if (this.#ownedRetries === 0) return;
    const ready = NodeTimers.setInterval(() => {
      void homeStarted(baseDir, child.pid ?? 0).then((started) => {
        if (!current() || !started) return;
        this.resetRetries();
        NodeTimers.clearInterval(ready);
      });
    }, 5_000);
    child.once("exit", () => NodeTimers.clearInterval(ready));
  }
}
