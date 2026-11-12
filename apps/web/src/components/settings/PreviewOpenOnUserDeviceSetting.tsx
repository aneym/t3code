import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { ScopedSwitch } from "./ScopedSwitch";
import { searchableSetting } from "./settingsSearch";

export function PreviewOpenOnUserDeviceSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("preview-open-on-user-device")}
      serverScoped
      settingKeys={["previewOpenOnUserDevice"]}
      description="Show the tabs agents open on the desktop app you are using, when it is connected. Otherwise they open in this environment's browser."
      resetAction={
        settings.previewOpenOnUserDevice !== DEFAULT_UNIFIED_SETTINGS.previewOpenOnUserDevice ? (
          <SettingResetButton
            label="open agent tabs on your desktop"
            onClick={() =>
              updateSettings({
                previewOpenOnUserDevice: DEFAULT_UNIFIED_SETTINGS.previewOpenOnUserDevice,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["previewOpenOnUserDevice"]}
          checked={settings.previewOpenOnUserDevice}
          onCheckedChange={(checked) =>
            updateSettings({ previewOpenOnUserDevice: Boolean(checked) })
          }
          aria-label="Open agent tabs on your desktop"
        />
      }
    />
  );
}
