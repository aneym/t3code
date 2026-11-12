import type { ClientSettings } from "@t3tools/contracts";

export const markFollowUpDefaultApplied = (settings: ClientSettings): ClientSettings => ({
  ...settings,
  followUpBehaviorQueueDefaultApplied: true,
});

export const migrateFollowUpDefault = (settings: ClientSettings): ClientSettings | null =>
  settings.followUpBehaviorQueueDefaultApplied
    ? null
    : markFollowUpDefaultApplied({ ...settings, followUpBehavior: "queue" });
