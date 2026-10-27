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

function compareVersionIdentifiers(left: string, right: string): number {
  const leftNumber = /^\\d+$/.test(left);
  const rightNumber = /^\\d+$/.test(right);
  if (leftNumber && rightNumber) return Number(left) - Number(right);
  if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isVersionOlder(target: string, current: string): boolean {
  const [targetCore, targetPre = ""] = target.split("+", 1)[0]!.split("-", 2);
  const [currentCore, currentPre = ""] = current.split("+", 1)[0]!.split("-", 2);
  const coreComparison = targetCore!.split(".").reduce((result, part, index) => {
    if (result !== 0) return result;
    return Number(part) - Number(currentCore!.split(".")[index] ?? 0);
  }, 0);
  if (coreComparison !== 0) return coreComparison < 0;
  if (targetPre === currentPre) return false;
  if (targetPre === "") return false;
  if (currentPre === "") return true;
  const targetParts = targetPre.split(".");
  const currentParts = currentPre.split(".");
  for (let index = 0; index < Math.max(targetParts.length, currentParts.length); index += 1) {
    const targetPart = targetParts[index];
    const currentPart = currentParts[index];
    if (targetPart === undefined) return true;
    if (currentPart === undefined) return false;
    const comparison = compareVersionIdentifiers(targetPart, currentPart);
    if (comparison !== 0) return comparison < 0;
  }
  return false;
}

export type ForkReleaseTarget = { readonly environmentId: EnvironmentId };
export type ForkReleaseValue = ForkReleaseList;
