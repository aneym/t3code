import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function UltracodeRainbowSetting() {
  const ultracodeRainbow = useScopedSettings((settings) => settings.ultracodeRainbow);
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("ultracode-rainbow")}
      description="Show Ultracode in rainbow letters in the composer while it is on, like Claude Code's ultrathink."
      resetAction={
        ultracodeRainbow !== DEFAULT_UNIFIED_SETTINGS.ultracodeRainbow ? (
          <SettingResetButton
            label="Ultracode colors"
            onClick={() =>
              updateSettings({ ultracodeRainbow: DEFAULT_UNIFIED_SETTINGS.ultracodeRainbow })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={ultracodeRainbow}
          onCheckedChange={(checked) => updateSettings({ ultracodeRainbow: Boolean(checked) })}
          aria-label="Ultracode colors"
        />
      }
    />
  );
}
