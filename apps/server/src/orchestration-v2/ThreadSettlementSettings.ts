import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const SweepCoalesceMs = Context.Reference("t3/ThreadSettlement/SweepCoalesceMs", {
  defaultValue: () => 250,
});

export const sweepCoalesceMs = Effect.gen(function* () {
  const fallback = yield* SweepCoalesceMs;
  return yield* Config.Int("T3CODE_SETTLEMENT_COALESCE_MS").pipe(
    Effect.orElseSucceed(() => fallback),
  );
});

/** @internal Exported for tests. */
export function autoSettlementSettingsKey(
  settings: import("@t3tools/contracts").ServerSettings,
): string {
  return JSON.stringify([
    settings.settleIdleChildren,
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

export function autoSettlementConfigured(
  settings: import("@t3tools/contracts").ServerSettings,
): boolean {
  if (settings.sidebarAutoSettleOnMerge || settings.sidebarAutoSettleAfterDays !== null) {
    return true;
  }
  return Object.values(settings.projectSettingsOverrides).some(
    (entry) =>
      entry.sidebarAutoSettleOnMerge === true ||
      (entry.sidebarAutoSettleAfterDays !== undefined && entry.sidebarAutoSettleAfterDays !== null),
  );
}
