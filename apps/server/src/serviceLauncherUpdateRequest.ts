// @effect-diagnostics nodeBuiltinImport:off -- Update admission belongs to the native service launcher.
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type * as NodeChildProcess from "node:child_process";
import { isCliForkVersion } from "@t3tools/shared/cliRelease";
import {
  compareExactServiceVersions,
  isExactServiceVersion,
  SERVICE_STATE_FILE,
  type PendingServiceUpdate,
  type ServiceState,
  type ServiceLauncherChildMessage,
} from "./cloud/serviceProtocol.ts";
import { databaseBackupBlocker, type BackupSpaceProbe } from "./serviceLauncherDatabase.ts";
import { runtimeExists, writeServiceState } from "./serviceLauncherState.ts";
import { sendMessage } from "./serviceLauncherMessages.ts";

export async function acceptServiceUpdate(
  baseDir: string,
  state: ServiceState,
  child: {
    readonly role: "active" | "trial";
    readonly version: string;
    readonly process: NodeChildProcess.ChildProcess;
  },
  message: Extract<ServiceLauncherChildMessage, { type: "request-update" }>,
  backupSpaceProbe?: Partial<BackupSpaceProbe>,
): Promise<PendingServiceUpdate | undefined> {
  const reject = (reason: string) =>
    sendMessage(child.process, { type: "update-rejected", reason }).catch(() => undefined);
  if (child.role !== "active") {
    await reject("Only the active server can request an update.");
    return;
  }
  if (child.version !== state.activeVersion) {
    await reject("The requesting server is not the selected active version.");
    return;
  }
  if (state.update?.status === "pending") {
    await reject("Another server update is already pending.");
    return;
  }
  if (!isExactServiceVersion(message.targetVersion)) {
    await reject("The requested target is not an exact version.");
    return;
  }
  if (isCliForkVersion(child.version) !== isCliForkVersion(message.targetVersion)) {
    await reject("The requested target is from a different distribution.");
    return;
  }
  const comparison = compareExactServiceVersions(message.targetVersion, child.version);
  if (comparison === 0 || (comparison < 0 && message.allowDowngrade !== true)) {
    await reject("Remote updates must select a newer server version.");
    return;
  }
  if (!NodePath.isAbsolute(message.dbPath)) {
    await reject("The requested database path is not absolute.");
    return;
  }
  if (!(await runtimeExists(baseDir, message.targetVersion))) {
    await reject("The requested target runtime is missing or incomplete.");
    return;
  }
  // Failed checks must refuse updates rather than stop the server with unknown backup capacity.
  const backupBlocker = await databaseBackupBlocker(
    baseDir,
    message.dbPath,
    backupSpaceProbe,
  ).catch(
    (error: unknown) =>
      `Could not check that the database backup fits before updating: ${error instanceof Error ? error.message : String(error)}. The server was not stopped.`,
  );
  if (!child.process.connected) return;
  if (backupBlocker !== undefined) {
    await reject(backupBlocker);
    return;
  }

  const pending: PendingServiceUpdate = {
    id: NodeCrypto.randomUUID(),
    fromVersion: child.version,
    targetVersion: message.targetVersion,
    dbPath: message.dbPath,
    status: "pending",
  };
  await writeServiceState(NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE), {
    ...state,
    update: pending,
  });
  return pending;
}
