// @effect-diagnostics nodeBuiltinImport:off -- The launcher lock is held outside the server runtime.
// @effect-diagnostics globalTimers:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { SERVICE_LAUNCHER_LOCK_FILE } from "./cloud/serviceProtocol.ts";

// A replacement started by a handoff waits up to two minutes for the stopping launcher.
const LOCK_RETRY_MS = 500;
const LOCK_ATTEMPTS = 240;

export const serviceLauncherLockPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_LAUNCHER_LOCK_FILE);

// An exclusive SQLite transaction, like the server's owner lock: the OS drops it when the holder dies.
async function tryAcquireSqliteLock(
  lockPath: string,
): Promise<{ readonly close: () => void } | undefined> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(lockPath);
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    return db;
  } catch (cause) {
    db.close();
    if (cause instanceof Error && "errcode" in cause && cause.errcode === 5) return undefined;
    throw cause;
  }
}

export async function serviceLauncherIsRunning(lockPath: string): Promise<boolean> {
  if (!NodeFS.existsSync(lockPath)) return false;
  const lock = await tryAcquireSqliteLock(lockPath);
  lock?.close();
  return lock === undefined;
}

/** Resolves once no launcher holds the lock; the caller bounds the wait through `signal`. */
export async function waitForServiceLauncherExit(
  lockPath: string,
  signal: AbortSignal,
): Promise<void> {
  while (await serviceLauncherIsRunning(lockPath)) {
    signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function acquireServiceLauncherLock(
  lockPath: string,
  stopped: () => boolean,
): Promise<{ readonly close: () => void } | undefined> {
  for (let attempt = 1; !stopped(); attempt++) {
    const lock = await tryAcquireSqliteLock(lockPath);
    if (lock !== undefined) return lock;
    if (attempt >= LOCK_ATTEMPTS) {
      throw new Error("Another T3 Code service launcher still runs for this T3 home.");
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
  return undefined;
}
