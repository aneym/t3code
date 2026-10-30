/** @internal Exported for tests. */
export function autoSettlementSettingsKey(
  settings: import("@t3tools/contracts").ServerSettings,
): string {
  return JSON.stringify([
    settings.sidebarAutoSettleOnMerge,
    settings.sidebarAutoSettleAfterDays,
    settings.sidebarAutoSettleKeepPullRequests,
    Object.entries(settings.projectSettingsOverrides)
      .filter(
        ([, entry]) =>
          entry.sidebarAutoSettleOnMerge !== undefined ||
          entry.sidebarAutoSettleAfterDays !== undefined ||
          entry.sidebarAutoSettleKeepPullRequests !== undefined,
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, entry]) => [
        projectId,
        entry.sidebarAutoSettleOnMerge ?? "inherit",
        entry.sidebarAutoSettleAfterDays === undefined
          ? "inherit"
          : entry.sidebarAutoSettleAfterDays,
        entry.sidebarAutoSettleKeepPullRequests ?? "inherit",
      ]),
  ]);
}
