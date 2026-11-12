import { OriginsInput } from "./OriginsInput";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function EmbedModeSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsRow
        serverScoped
        title="Bare chat for host apps"
        settingKeys={["embedModeEnabled"]}
        description="Let another app show one thread at /embed/<environment>/<thread>, with no sidebar, header or panel buttons. The app sends the chat's colors, and gets its links and reserved shortcuts back as messages."
        control={
          <ScopedSwitch
            settingKeys={["embedModeEnabled"]}
            checked={settings.embedModeEnabled}
            onCheckedChange={(checked) => updateSettings({ embedModeEnabled: Boolean(checked) })}
            aria-label="Bare chat for host apps"
          />
        }
      />
      {settings.embedModeEnabled ? (
        <SettingsRow
          serverScoped
          title="Pages that may show the bare chat"
          settingKeys={["embedAllowedOrigins"]}
          description="Web page origins allowed to frame it, separated by spaces. A desktop app that loads the page directly needs none."
          control={
            <OriginsInput
              saved={settings.embedAllowedOrigins}
              label="Pages that may show the bare chat"
              placeholder="https://app.example.com"
              onCommit={(origins) => updateSettings({ embedAllowedOrigins: origins })}
            />
          }
        />
      ) : null}
    </>
  );
}
