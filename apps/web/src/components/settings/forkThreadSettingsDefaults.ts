import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";

export const forkThreadSettingsDefaults = {
  batchQueuedMessages: DEFAULT_UNIFIED_SETTINGS.batchQueuedMessages,
  queueSendAll: DEFAULT_UNIFIED_SETTINGS.queueSendAll,
  settleIdleChildren: DEFAULT_UNIFIED_SETTINGS.settleIdleChildren,
};

export function changedForkThreadSettings(settings: UnifiedSettings): ReadonlyArray<string> {
  return [
    settings.queueSendAll !== forkThreadSettingsDefaults.queueSendAll
      ? "Send all queued messages"
      : null,
    settings.batchQueuedMessages !== forkThreadSettingsDefaults.batchQueuedMessages
      ? "Send queued messages together"
      : null,
    settings.settleIdleChildren !== forkThreadSettingsDefaults.settleIdleChildren
      ? "Settle idle child threads"
      : null,
  ].filter((label) => label !== null);
}
