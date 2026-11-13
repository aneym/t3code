import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";

import desktopPackageJson from "../../apps/desktop/package.json" with { type: "json" };

export function resolveDesktopUpdateChannel(version: string): "latest" | "nightly" {
  return cliReleaseChannelOf(version) === "nightly" ? "nightly" : "latest";
}

export function isDesktopPreviewVersion(version: string): boolean {
  return /-pr\./.test(version) || /-preview\.\d{8}\.\d+$/.test(version);
}

export function resolveDesktopProductName(version: string): string {
  if (version.includes(".aneym.")) return "T3 Dev";
  return resolveDesktopUpdateChannel(version) === "nightly"
    ? "T3 Code (Nightly)"
    : (desktopPackageJson.productName ?? "T3 Code");
}
