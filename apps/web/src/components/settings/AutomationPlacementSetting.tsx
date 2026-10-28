import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function AutomationPlacementSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("retain-automation-placement")}
      serverScoped
      settingKeys={["retainAutomationPlacement"]}
      description="Mark existing threads as automations when a scheduled task wakes them, and keep automation wakes snoozed."
      control={
        <ScopedSwitch
          settingKeys={["retainAutomationPlacement"]}
          checked={settings.retainAutomationPlacement}
          onCheckedChange={(checked) =>
            updateSettings({ retainAutomationPlacement: Boolean(checked) })
          }
          aria-label="Keep automation threads together"
        />
      }
    />
  );
}
