import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";
import type { DesktopUpdateChannel } from "@t3tools/contracts";

export function isNightlyDesktopVersion(version: string): boolean {
  return cliReleaseChannelOf(version) !== "stable";
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return cliReleaseChannelOf(appVersion) === "nightly" ? "nightly" : "latest";
}
