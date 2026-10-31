import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { ScopedSwitch } from "./ScopedSwitch";
import { searchableSetting } from "./settingsSearch";

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
      ].map(({ key, searchId, label, description }) => {
        const settingKey = key as "batchQueuedMessages" | "queueSendAll" | "settleIdleChildren";
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
    </>
  );
}
