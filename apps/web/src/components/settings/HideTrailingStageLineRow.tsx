import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function HideTrailingStageLineRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("hide-trailing-stage-line")}
      description="Hide the last line of an agent reply when it is a stage line like Done · or Working ·. Copy still includes it."
      resetAction={
        settings.hideTrailingStageLine !== DEFAULT_UNIFIED_SETTINGS.hideTrailingStageLine ? (
          <SettingResetButton
            label="hide stage lines"
            onClick={() =>
              updateSettings({
                hideTrailingStageLine: DEFAULT_UNIFIED_SETTINGS.hideTrailingStageLine,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.hideTrailingStageLine}
          onCheckedChange={(checked) => updateSettings({ hideTrailingStageLine: checked })}
          aria-label="Hide stage lines"
        />
      }
    />
  );
}
