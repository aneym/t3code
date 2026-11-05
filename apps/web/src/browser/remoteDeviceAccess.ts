import type { ClientSettings, PreviewSessionSnapshot } from "@t3tools/contracts";

import { getClientSettings, useClientSettings } from "~/hooks/useSettings";

export type RemoteDeviceAccess = "off" | "show" | "control";

const accessFrom = (settings: ClientSettings): RemoteDeviceAccess => {
  if (!settings.browserAllowRemoteDeviceTabs) return "off";
  return settings.browserAllowRemoteDeviceControl ? "control" : "show";
};

export function remoteDeviceAccess(): RemoteDeviceAccess {
  return accessFrom(getClientSettings());
}

export function useRemoteDeviceAccess(): RemoteDeviceAccess {
  return useClientSettings(accessFrom);
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
