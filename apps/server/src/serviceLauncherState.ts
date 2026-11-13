// @effect-diagnostics nodeBuiltinImport:off -- The launcher persists state independently of server modules.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  compareExactServiceVersions,
  isExactServiceVersion,
  parseLegacyServiceState,
  parseServiceState,
  SERVICE_LAUNCHER_PROTOCOL,
  type ServiceState,
} from "./cloud/serviceProtocol.ts";
import { acquireServiceSelectionLock } from "./cloud/serviceSelectionLock.ts";
export const runtimePaths = (baseDir: string, version: string) => {
  const versionDir = NodePath.join(baseDir, "runtime", "versions", version);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const executableName = process.platform === "win32" ? "t3.exe" : "t3";
  return {
    versionDir,
    entryPath: NodePath.join(versionDir, executableName),
    sentinelPath: NodePath.join(versionDir, ".install-complete"),
  };
};

export const runtimeSpawnArguments = (paths: ReturnType<typeof runtimePaths>) => ({
  command: paths.entryPath,
  args: ["serve"],
});

async function syncDirectory(directory: string): Promise<void> {
  const handle = await NodeFSP.open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  } finally {
    await handle.close();
  }
}

// An older coordinator can write protocol 2 beside a newer runtime. Adopt
// only its install record, in memory: rewriting it outside the selection lock
// could replace state a concurrent install wrote after this read.
export function adoptLegacyServiceState(contents: string): ServiceState | undefined {
  const legacy = parseLegacyServiceState(contents);
  return legacy && { protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: legacy.activeVersion };
}

export async function readServiceState(filePath: string): Promise<ServiceState> {
  const contents = await NodeFSP.readFile(filePath, "utf8");
  const state = parseServiceState(contents) ?? adoptLegacyServiceState(contents);
  if (state === undefined) throw new Error("Service state is invalid or unsupported.");
  return state;
}

export async function writeServiceState(filePath: string, state: ServiceState): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
  await replaceFileDurably(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

export async function replaceFileDurably(filePath: string, contents: string): Promise<void> {
  const directory = NodePath.dirname(filePath);
  const tempPath = NodePath.join(
    directory,
    `.${NodePath.basename(filePath)}.${process.pid}.${NodeCrypto.randomUUID()}`,
  );
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(tempPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await NodeFSP.rename(tempPath, filePath);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await NodeFSP.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export const sameServiceSelection = (selected: ServiceState, current: ServiceState) =>
  selected.activeVersion === current.activeVersion &&
  selected.update?.id === current.update?.id &&
  selected.update?.status === current.update?.status;

export async function selectServiceState(
  statePath: string,
  current: ServiceState,
  next: ServiceState,
): Promise<void> {
  const release = await acquireServiceSelectionLock(statePath);
  try {
    // Local installs replace the selection and clear its update record. An old
    // launcher must not restore its own selection when asked to update again.
    if (!sameServiceSelection(await readServiceState(statePath), current)) {
      throw new Error("Service selection changed. Restart the service before updating.");
    }
    await writeServiceState(statePath, next);
  } finally {
    release();
  }
}

// Clear restart-pending only for the awaited version to avoid CLI races.
export async function clearAwaitedRestart(
  statePath: string,
  restartPending: string,
  current: ServiceState,
): Promise<void> {
  try {
    const release = await acquireServiceSelectionLock(statePath);
    try {
      const awaitedVersion = await NodeFSP.readFile(restartPending, "utf8").catch(() => undefined);
      const awaited = awaitedVersion?.trim();
      if (
        sameServiceSelection(await readServiceState(statePath), current) &&
        awaited !== undefined &&
        isExactServiceVersion(awaited) &&
        compareExactServiceVersions(awaited, current.activeVersion) <= 0
      ) {
        await NodeFSP.rm(restartPending, { force: true });
      }
    } finally {
      release();
    }
  } catch (error) {
    process.stderr.write(
      `[service-launcher] Could not clear ${restartPending}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

export async function runtimeExists(baseDir: string, version: string): Promise<boolean> {
  const paths = runtimePaths(baseDir, version);
  try {
    const [entry, sentinel] = await Promise.all([
      NodeFSP.stat(paths.entryPath),
      NodeFSP.readFile(paths.sentinelPath, "utf8"),
    ]);
    return entry.isFile() && sentinel.trim() === version;
  } catch {
    return false;
  }
}
