// @effect-diagnostics nodeBuiltinImport:off -- The launcher bounds its log outside the server runtime.
// @effect-diagnostics globalTimers:off
import * as NodeFSP from "node:fs/promises";

import { serviceUnitLogPathOf } from "./cloud/serviceProtocol.ts";
import type { ServiceUnit } from "./serviceUnit.ts";

const SERVICE_LOG_MAX_BYTES = 10 * 1024 * 1024;
const SERVICE_LOG_CHECK_INTERVAL_MS = 10 * 60_000;

/**
 * The service manager holds the log open for appending, so it is copied aside and emptied in
 * place rather than renamed. The copy is best effort: on a full disk the truncate frees space.
 */
async function boundServiceLog(logPath: string): Promise<void> {
  const size = await NodeFSP.stat(logPath).then(
    (stats) => stats.size,
    () => 0,
  );
  if (size <= SERVICE_LOG_MAX_BYTES) return;
  const archivePath = `${logPath}.1`;
  const pendingArchivePath = `${archivePath}.tmp`;
  await NodeFSP.copyFile(logPath, pendingArchivePath)
    .then(() => NodeFSP.rename(pendingArchivePath, archivePath))
    .catch(() => NodeFSP.rm(pendingArchivePath, { force: true }).catch(() => undefined));
  await NodeFSP.truncate(logPath, 0).catch(() => undefined);
}

async function serviceLogPath(
  logFile: string | undefined,
  serviceUnit: ServiceUnit | undefined,
): Promise<string | undefined> {
  if (logFile !== undefined) return logFile;
  if (serviceUnit === undefined) return undefined;
  const contents = await NodeFSP.readFile(serviceUnit.path, "utf8").catch(() => undefined);
  return contents === undefined ? undefined : serviceUnitLogPathOf(contents);
}

export async function boundServiceLogPeriodically(
  logFile: string | undefined,
  serviceUnit: ServiceUnit | undefined,
): Promise<NodeJS.Timeout | undefined> {
  const logPath = await serviceLogPath(logFile, serviceUnit);
  if (logPath === undefined) return undefined;
  await boundServiceLog(logPath);
  return setInterval(() => void boundServiceLog(logPath), SERVICE_LOG_CHECK_INTERVAL_MS).unref();
}
