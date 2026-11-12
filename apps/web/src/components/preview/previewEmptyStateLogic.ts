import type { PreviewSessionSnapshot, ProjectScript } from "@t3tools/contracts";

export function shouldShowPreviewEmptyState(
  snapshot: PreviewSessionSnapshot | null,
  navStatus = snapshot?.navStatus,
): boolean {
  return snapshot === null || navStatus?._tag === "Idle";
}

export function getConfiguredPreviewUrls(
  scripts: ReadonlyArray<ProjectScript> | undefined,
): ReadonlyArray<string> {
  return scripts?.flatMap((script) => (script.previewUrl ? [script.previewUrl] : [])) ?? [];
}
