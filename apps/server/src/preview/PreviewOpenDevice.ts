import type { PreviewAutomationOpenInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

interface ConnectedDevice {
  readonly name: string;
  readonly focused: boolean;
  readonly lastFocusedAt: number;
}

const recentDevice = (devices: ReadonlyArray<ConnectedDevice>) =>
  devices.toSorted(
    (a, b) => Number(b.focused) - Number(a.focused) || b.lastFocusedAt - a.lastFocusedAt,
  )[0]?.name;

const namedDevice = (devices: ReadonlyArray<ConnectedDevice>, wanted: string) => {
  const lower = wanted.toLowerCase();
  return (
    devices.find((device) => device.name.toLowerCase() === lower)?.name ??
    devices.find((device) => device.name.toLowerCase().includes(lower))?.name
  );
};

export const make = Effect.gen(function* () {
  const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
  const settings = yield* ServerSettings.ServerSettingsService;
  const opensOnUserDevice = settings.getSettings.pipe(
    Effect.map((current) => current.previewOpenOnUserDevice),
    Effect.orElseSucceed(() => false),
  );
  return Effect.fn("PreviewOpenDevice.resolve")(function* (open: PreviewAutomationOpenInput) {
    if (!channel.devices || !(yield* opensOnUserDevice)) return undefined;
    if (open.device === undefined) {
      if ((open.open ?? open.show) === false) return undefined;
      return recentDevice(yield* channel.devices);
    }
    const devices = yield* channel.devices;
    const wanted =
      open.device === "user" ? recentDevice(devices) : namedDevice(devices, open.device);
    if (wanted) return wanted;
    return yield* Effect.fail(
      new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        `No connected device matches "${open.device}". Connected devices: ${devices.map((device) => device.name).join(", ") || "none"}.`,
      ),
    );
  });
});
