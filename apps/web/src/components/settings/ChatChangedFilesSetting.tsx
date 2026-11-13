import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function ChatChangedFilesSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("show-chat-changed-files")}
      description="Show the changed-files card under assistant messages. Diffs stay available in the diff panel."
      resetAction={
        settings.showChatChangedFiles !== DEFAULT_UNIFIED_SETTINGS.showChatChangedFiles ? (
          <SettingResetButton
            label="changed files in chat"
            onClick={() =>
              updateSettings({
                showChatChangedFiles: DEFAULT_UNIFIED_SETTINGS.showChatChangedFiles,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.showChatChangedFiles}
          onCheckedChange={(checked) => updateSettings({ showChatChangedFiles: Boolean(checked) })}
          aria-label="Show changed files in chat"
        />
      }
    />
  );
}
