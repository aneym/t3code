import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";

export const forkThreadSettingsDefaults = {
  batchQueuedMessages: DEFAULT_UNIFIED_SETTINGS.batchQueuedMessages,
  queueSendAll: DEFAULT_UNIFIED_SETTINGS.queueSendAll,
  settleIdleChildren: DEFAULT_UNIFIED_SETTINGS.settleIdleChildren,
  quietThreadNotes: DEFAULT_UNIFIED_SETTINGS.quietThreadNotes,
  childCompletionNotes: DEFAULT_UNIFIED_SETTINGS.childCompletionNotes,
  headlessSubagentStreaming: DEFAULT_UNIFIED_SETTINGS.headlessSubagentStreaming,
  mcpEventsEnabled: DEFAULT_UNIFIED_SETTINGS.mcpEventsEnabled,
  mcpClientApprovals: DEFAULT_UNIFIED_SETTINGS.mcpClientApprovals,
  hostLinkEnabled: DEFAULT_UNIFIED_SETTINGS.hostLinkEnabled,
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
    settings.quietThreadNotes !== forkThreadSettingsDefaults.quietThreadNotes
      ? "Quiet thread notes"
      : null,
    settings.childCompletionNotes !== forkThreadSettingsDefaults.childCompletionNotes
      ? "Quiet child completions"
      : null,
    settings.headlessSubagentStreaming !== forkThreadSettingsDefaults.headlessSubagentStreaming
      ? "Headless child threads"
      : null,
    settings.mcpEventsEnabled !== forkThreadSettingsDefaults.mcpEventsEnabled
      ? "MCP Events subscriptions"
      : null,
    settings.mcpClientApprovals !== forkThreadSettingsDefaults.mcpClientApprovals
      ? "Approvals from MCP clients"
      : null,
    settings.hostLinkEnabled !== forkThreadSettingsDefaults.hostLinkEnabled
      ? "Host app link"
      : null,
  ].filter((label) => label !== null);
}
