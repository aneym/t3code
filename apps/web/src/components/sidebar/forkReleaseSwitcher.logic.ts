import type { EnvironmentId, ForkRelease, ForkReleaseList } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "~/connection/runtime";

export const listForkReleases = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:server:list-fork-releases",
  tag: WS_METHODS.serverListForkReleases,
});

export type ForkReleaseResult = Awaited<ReturnType<typeof listForkReleases.run>>;

export function releaseLabel(release: Pick<ForkRelease, "version">): string {
  return release.version.replace(/^v/, "");
}

export function hasMacArmDesktop(release: ForkRelease): boolean {
  return release.desktop.includes("mac-arm64");
}

export function isUnknownMethodFailure(result: { readonly _tag: string }): boolean {
  return result._tag === "Failure" && String(result).toLowerCase().includes("unknown method");
}

export function releaseDate(release: ForkRelease): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(release.builtAt),
  );
}

export type ForkReleaseTarget = { readonly environmentId: EnvironmentId };
export type ForkReleaseValue = ForkReleaseList;
