import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function RailsCommentCardsSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      title="Rails comments as cards"
      settingKeys={["railsCommentCardsEnabled"]}
      description="Show a comment Rails relays from a doc or page as a card with its author, doc, quoted text and a link to the comment, instead of your own message."
      control={
        <ScopedSwitch
          settingKeys={["railsCommentCardsEnabled"]}
          checked={settings.railsCommentCardsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ railsCommentCardsEnabled: Boolean(checked) })
          }
          aria-label="Rails comments as cards"
        />
      }
    />
  );
}
