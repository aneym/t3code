import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function LaneResultRowsSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      title="Rails lane results as quiet rows"
      settingKeys={["laneResultRowsEnabled"]}
      description="Show the line Rails posts when a lane finishes as one collapsed row, such as “Staff map · finished”, instead of your own message. Open it to read the lane's own words."
      control={
        <ScopedSwitch
          settingKeys={["laneResultRowsEnabled"]}
          checked={settings.laneResultRowsEnabled}
          onCheckedChange={(checked) => updateSettings({ laneResultRowsEnabled: Boolean(checked) })}
          aria-label="Rails lane results as quiet rows"
        />
      }
    />
  );
}
