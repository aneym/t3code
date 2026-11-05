import { useAtomValue } from "@effect/atom-react";
import type {
  ClientSettings,
  EnvironmentId,
  PreviewSessionSnapshot,
  ServerConfig,
} from "@t3tools/contracts";

import { getClientSettings, useClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentServerConfigsAtom } from "~/state/server";

export type RemoteDeviceAccess = "off" | "show" | "control";
export type RemoteDeviceAccessFor = (environmentId: EnvironmentId) => RemoteDeviceAccess;

const accessFrom = (settings: ClientSettings): RemoteDeviceAccess => {
  if (!settings.browserAllowRemoteDeviceTabs) return "off";
  return settings.browserAllowRemoteDeviceControl ? "control" : "show";
};

const scopedAccess =
  (
    access: RemoteDeviceAccess,
    configs: ReadonlyMap<EnvironmentId, ServerConfig>,
  ): RemoteDeviceAccessFor =>
  (environmentId) =>
    configs.get(environmentId)?.settings.previewOpenOnUserDevice === true ? access : "off";

export function remoteDeviceAccess(): RemoteDeviceAccess {
  return accessFrom(getClientSettings());
}

export function remoteDeviceAccessFor(): RemoteDeviceAccessFor {
  return scopedAccess(remoteDeviceAccess(), appAtomRegistry.get(environmentServerConfigsAtom));
}

export function useRemoteDeviceAccess(): RemoteDeviceAccess {
  return useClientSettings(accessFrom);
}

export function useRemoteDeviceAccessFor(): RemoteDeviceAccessFor {
  return scopedAccess(useRemoteDeviceAccess(), useAtomValue(environmentServerConfigsAtom));
}

export function remoteDeviceTabAccess(
  snapshot: Pick<PreviewSessionSnapshot, "device">,
  access: RemoteDeviceAccess,
): RemoteDeviceAccess {
  const localDevice =
    typeof window !== "undefined" ? window.desktopBridge?.getDeviceName?.() : undefined;
  if (snapshot.device === undefined || snapshot.device !== localDevice) return "off";
  return access;
}
