import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PreviewRuntime, PreviewSessionSnapshot } from "@t3tools/contracts";

import { isElectron } from "~/env";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
} from "~/state/entities";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { readPreparedConnection } from "~/state/session";

import {
  type RemoteDeviceAccess,
  type RemoteDeviceAccessFor,
  remoteDeviceTabAccess,
  useRemoteDeviceAccessFor,
} from "./remoteDeviceAccess";
import { publicTabUrl } from "./remoteTabUrl";

type NativeTabSnapshot = Pick<
  PreviewSessionSnapshot,
  "runtime" | "device" | "headless" | "navStatus"
>;

export function isLocalPreviewEnvironment(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
): boolean {
  if (environmentId === primaryEnvironmentId) return true;
  const target = readPreparedConnection(environmentId)?.target;
  return target !== undefined && isDesktopLocalConnectionTarget(target);
}

export function guardsPreviewTab(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  access: RemoteDeviceAccess,
): boolean {
  return access !== "off" && !isLocalPreviewEnvironment(environmentId, primaryEnvironmentId);
}

export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  if (!readEnvironmentSupportsServerBrowser(environmentId)) return undefined;
  if (
    isPreviewSupportedInRuntime() &&
    environmentId !== appAtomRegistry.get(primaryEnvironmentIdAtom)
  ) {
    return undefined;
  }
  return "server";
}

export function alternatePreviewRuntime(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  serverBrowser: boolean,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): PreviewRuntime | null {
  if (!snapshot || !serverBrowser || !isPreviewSupportedInRuntime()) return null;
  if (environmentId === primaryEnvironmentId) return null;
  return snapshot.runtime === "server" ? "desktop" : "server";
}

export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(environmentId);
}

export function usePreviewAvailable(environmentId: EnvironmentId | null): boolean {
  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  return isPreviewSupportedInRuntime() || serverBrowser;
}

export function rendersServerTabNatively(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: NativeTabSnapshot | null | undefined,
  accessFor: RemoteDeviceAccessFor,
): boolean {
  if (!isElectron || snapshot?.runtime !== "server") return false;
  if (primaryEnvironmentId !== null && environmentId === primaryEnvironmentId)
    return !snapshot.headless;
  const access = remoteDeviceTabAccess(snapshot, accessFor(environmentId));
  if (access === "off" || (access === "control" && snapshot.headless)) return false;
  const status = snapshot.navStatus;
  return status._tag === "Idle" || publicTabUrl(status.url) !== null;
}

export function serverDrivesNativeTab(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: NativeTabSnapshot,
  accessFor: RemoteDeviceAccessFor,
): boolean {
  if (!rendersServerTabNatively(environmentId, primaryEnvironmentId, snapshot, accessFor))
    return false;
  if (snapshot.headless) return false;
  return (
    environmentId === primaryEnvironmentId ||
    remoteDeviceTabAccess(snapshot, accessFor(environmentId)) === "control"
  );
}

export function useRendersServerTabNatively(
  environmentId: EnvironmentId | null,
  snapshot: NativeTabSnapshot | null | undefined,
): boolean {
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const accessFor = useRemoteDeviceAccessFor();
  if (environmentId === null) return false;
  return rendersServerTabNatively(environmentId, primaryEnvironmentId, snapshot, accessFor);
}
