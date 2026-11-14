import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";

export const forkThreadSettingsDefaults = {
  showChatChangedFiles: DEFAULT_UNIFIED_SETTINGS.showChatChangedFiles,
  batchQueuedMessages: DEFAULT_UNIFIED_SETTINGS.batchQueuedMessages,
  queueSendAll: DEFAULT_UNIFIED_SETTINGS.queueSendAll,
  quietThreadNotes: DEFAULT_UNIFIED_SETTINGS.quietThreadNotes,
  childCompletionNotes: DEFAULT_UNIFIED_SETTINGS.childCompletionNotes,
  headlessSubagentStreaming: DEFAULT_UNIFIED_SETTINGS.headlessSubagentStreaming,
  mcpEventsEnabled: DEFAULT_UNIFIED_SETTINGS.mcpEventsEnabled,
  mcpClientApprovals: DEFAULT_UNIFIED_SETTINGS.mcpClientApprovals,
  peerLinkRenewalEnabled: DEFAULT_UNIFIED_SETTINGS.peerLinkRenewalEnabled,
};

export function changedForkThreadSettings(settings: UnifiedSettings): ReadonlyArray<string> {
  return [
    settings.showChatChangedFiles !== forkThreadSettingsDefaults.showChatChangedFiles
      ? "Changed files in chat"
      : null,
    settings.batchQueuedMessages !== forkThreadSettingsDefaults.batchQueuedMessages
      ? "Send queued messages together"
      : null,
    settings.queueSendAll !== forkThreadSettingsDefaults.queueSendAll ? "Send all queued" : null,
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
    settings.peerLinkRenewalEnabled !== forkThreadSettingsDefaults.peerLinkRenewalEnabled
      ? "Renew links without a code"
      : null,
  ].filter((label) => label !== null);
}
