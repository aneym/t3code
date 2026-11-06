import { Switch } from "~/components/ui/switch";
import { persistClientSettingsUpdate, useClientSettings } from "~/hooks/useSettings";

import { RemoteDeviceTabsSettings } from "./RemoteDeviceTabsSettings";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function FillOneTimeCodesSetting({ disabled }: { readonly disabled: boolean }) {
  const fill = useClientSettings((settings) => settings.browserFillOneTimeCodes);
  return (
    <SettingsRow
      {...searchableSetting("browser-fill-one-time-codes")}
      description="While a verification code field is focused, fill it when you copy a code, for example with Copy Code on a Messages notification."
      control={
        <Switch
          disabled={disabled}
          checked={fill}
          onCheckedChange={(checked) =>
            void persistClientSettingsUpdate((settings) => ({
              ...settings,
              browserFillOneTimeCodes: Boolean(checked),
            }))
          }
          aria-label="Fill copied verification codes"
        />
      }
    />
  );
}

export function BrowserForkSettings({ disabled }: { readonly disabled: boolean }) {
  return (
    <>
      <FillOneTimeCodesSetting disabled={disabled} />
      <RemoteDeviceTabsSettings disabled={disabled} />
    </>
  );
}
