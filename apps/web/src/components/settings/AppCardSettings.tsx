import { OriginsInput } from "./OriginsInput";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function AppCardSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsRow
        serverScoped
        title="Rails app cards"
        settingKeys={["appCardsEnabled"]}
        description="Inside the Rails desktop app, show the Rails card for an app a tool call opened, under that call. Only the newest card for each lane and app shows. Elsewhere the tool call shows as usual and nothing is loaded from Rails."
        control={
          <ScopedSwitch
            settingKeys={["appCardsEnabled"]}
            checked={settings.appCardsEnabled}
            onCheckedChange={(checked) => updateSettings({ appCardsEnabled: Boolean(checked) })}
            aria-label="Rails app cards"
          />
        }
      />
      {settings.appCardsEnabled ? (
        <SettingsRow
          serverScoped
          title="Rails origins for app cards"
          settingKeys={["appCardAllowedOrigins"]}
          description="Origins whose cards may show, separated by spaces."
          control={
            <OriginsInput
              saved={settings.appCardAllowedOrigins}
              label="Rails origins for app cards"
              placeholder="https://one.rails.so"
              onCommit={(origins) => updateSettings({ appCardAllowedOrigins: origins })}
            />
          }
        />
      ) : null}
    </>
  );
}
