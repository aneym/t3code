import { Switch } from "~/components/ui/switch";
import { persistClientSettingsUpdate, useClientSettings } from "~/hooks/useSettings";

import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function RemoteDeviceTabsSettings({ disabled }: { readonly disabled: boolean }) {
  const showTabs = useClientSettings((settings) => settings.browserShowRemoteDeviceTabs);
  const allowControl = useClientSettings((settings) => settings.browserAllowRemoteDeviceControl);
  return (
    <>
      <SettingsRow
        {...searchableSetting("remote-device-tabs")}
        description="Show tabs that agents on your other machines open. They only see the page address; they cannot read or drive this app's browser."
        control={
          <Switch
            disabled={disabled}
            checked={showTabs}
            onCheckedChange={(checked) =>
              void persistClientSettingsUpdate((settings) => ({
                ...settings,
                browserShowRemoteDeviceTabs: Boolean(checked),
              }))
            }
            aria-label="Show agent tabs from other machines"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("remote-device-control")}
        description="Also let those agents drive the tab here: run scripts, click, type, and read the page and its cookies."
        control={
          <Switch
            disabled={disabled || !showTabs}
            checked={showTabs && allowControl}
            onCheckedChange={(checked) =>
              void persistClientSettingsUpdate((settings) => ({
                ...settings,
                browserAllowRemoteDeviceControl: Boolean(checked),
              }))
            }
            aria-label="Let other machines control agent tabs"
          />
        }
      />
    </>
  );
}
