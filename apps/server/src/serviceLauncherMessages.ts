// @effect-diagnostics nodeBuiltinImport:off -- Launcher messages and markers are native process boundaries.
import type * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  SERVICE_STOP_MARKER_FILE,
  SERVICE_RESTART_PENDING_FILE,
  type PendingServiceUpdate,
  type ServiceUpdateRecord,
  type ServiceLauncherParentMessage,
} from "./cloud/serviceProtocol.ts";
type TerminalStatus = "committed" | "rolled-back" | "failed";
export function terminalUpdate<S extends TerminalStatus>(input: {
  readonly pending: PendingServiceUpdate;
  readonly status: S;
  readonly reason?: string;
}): Exclude<ServiceUpdateRecord, PendingServiceUpdate> & { readonly status: S } {
  return {
    id: input.pending.id,
    fromVersion: input.pending.fromVersion,
    targetVersion: input.pending.targetVersion,
    status: input.status,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

export function sendMessage(
  child: NodeChildProcess.ChildProcess,
  message: ServiceLauncherParentMessage,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected || child.send === undefined) {
      reject(new Error("service child IPC is disconnected."));
      return;
    }
    child.send(message, (error) => (error === null ? resolve() : reject(error)));
  });
}

export const stopMarkerPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_STOP_MARKER_FILE);
export const writeStopMarker = (baseDir: string) =>
  NodeFSP.writeFile(stopMarkerPath(baseDir), "", { mode: 0o600 }).catch(() => undefined);
export const restartPendingPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);
