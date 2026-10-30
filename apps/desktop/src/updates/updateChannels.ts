import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";

export function isNightlyDesktopVersion(version: string): boolean {
  return cliReleaseChannelOf(version) !== "stable";
}
