import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { ScopedSwitch } from "./ScopedSwitch";
import { searchableSetting } from "./settingsSearch";
import { DelegatedChildModelSetting } from "./DelegatedChildModelSetting";

export function QueueSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      {[
        {
          key: "settleIdleChildren",
          searchId: "settle-idle-children",
          label: "Settle idle child threads",
          description:
            "Settle idle child threads when their parent is settled. Keep running, waiting, pinned, snoozed, and explicitly active children open.",
        },
        {
          key: "batchQueuedMessages",
          searchId: "batch-queued-messages",
          label: "Send queued messages together",
          description:
            "When a turn ends, start up to 20 compatible queued messages on the thread together as one turn instead of one turn each.",
        },
        {
          key: "queueSendAll",
          searchId: "queue-send-all",
          label: "Send all queued messages",
          description:
            "Show Send all to release and send up to 20 compatible queued messages together, into the current turn or as one new turn.",
        },
        {
          key: "quietThreadNotes",
          searchId: "quiet-thread-notes",
          label: "Quiet thread notes",
          description:
            "Let agents post notes that show in a thread without starting a turn. The thread's next turn reads them as context.",
        },
        {
          key: "childCompletionNotes",
          searchId: "child-completion-notes",
          label: "Quiet child completions",
          description:
            "A delegated child that reports a clean result while its siblings still run posts it as a note instead of starting a turn. Failures, gaps, awaited children and the last child still wake the lead.",
        },
        {
          key: "headlessSubagentStreaming",
          searchId: "headless-child-threads",
          label: "Headless child threads",
          description:
            "Child threads stream to an open client only. While no one watches one, its turns store finished messages and skip partial text, thinking and token updates.",
        },
        {
          key: "mcpEventsEnabled",
          searchId: "mcp-events",
          label: "MCP Events subscriptions",
          description:
            "Let agents subscribe threads to MCP servers' events. A verified event wakes the thread or queues into its turn.",
        },
        {
          key: "mcpClientApprovals",
          searchId: "mcp-client-approvals",
          label: "Approvals from MCP clients",
          description:
            "Let a person's MCP client, such as the t3 CLI or an app you approved, approve or decline a thread's permission requests. Agents can never decide them.",
        },
        {
          key: "hostLinkEnabled",
          searchId: "host-link",
          label: "Host app link",
          description:
            "Push turns, messages, steps and thread ends of threads with a host lane to the linked host app. Link one with `t3 host-link set`.",
        },
      ].map(({ key, searchId, label, description }) => {
        const settingKey = key as
          | "batchQueuedMessages"
          | "queueSendAll"
          | "settleIdleChildren"
          | "quietThreadNotes"
          | "childCompletionNotes"
          | "headlessSubagentStreaming"
          | "mcpEventsEnabled"
          | "mcpClientApprovals"
          | "hostLinkEnabled";
        return (
          <SettingsRow
            key={key}
            {...searchableSetting(searchId)}
            serverScoped
            settingKeys={[settingKey]}
            description={description}
            resetAction={
              settings[settingKey] !== DEFAULT_UNIFIED_SETTINGS[settingKey] ? (
                <SettingResetButton
                  label={label}
                  onClick={() =>
                    updateSettings({ [settingKey]: DEFAULT_UNIFIED_SETTINGS[settingKey] })
                  }
                />
              ) : null
            }
            control={
              <ScopedSwitch
                settingKeys={[settingKey]}
                checked={settings[settingKey]}
                onCheckedChange={(checked) => updateSettings({ [settingKey]: Boolean(checked) })}
                aria-label={label}
              />
            }
          />
        );
      })}
      <DelegatedChildModelSetting />
    </>
  );
}
