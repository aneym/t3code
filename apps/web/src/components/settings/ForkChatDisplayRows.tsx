import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export const forkChatDisplayDefaults = {
  hideTrailingStageLine: DEFAULT_UNIFIED_SETTINGS.hideTrailingStageLine,
  keepOpeningReplyVisible: DEFAULT_UNIFIED_SETTINGS.keepOpeningReplyVisible,
};

export function changedForkChatDisplaySettings(settings: UnifiedSettings): ReadonlyArray<string> {
  return [
    settings.hideTrailingStageLine !== DEFAULT_UNIFIED_SETTINGS.hideTrailingStageLine
      ? "Hide stage lines"
      : null,
    settings.keepOpeningReplyVisible !== DEFAULT_UNIFIED_SETTINGS.keepOpeningReplyVisible
      ? "Keep replies visible"
      : null,
  ].filter((label) => label !== null);
}

export function ForkChatDisplayRows() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
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
      <SettingsRow
        {...searchableSetting("keep-opening-reply-visible")}
        description="Keep what an agent says before its first tool call, and its last line when a turn ends on a tool call, in the chat instead of folding it into Worked for or a superseded attempt."
        resetAction={
          settings.keepOpeningReplyVisible !== DEFAULT_UNIFIED_SETTINGS.keepOpeningReplyVisible ? (
            <SettingResetButton
              label="keep replies visible"
              onClick={() =>
                updateSettings({
                  keepOpeningReplyVisible: DEFAULT_UNIFIED_SETTINGS.keepOpeningReplyVisible,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.keepOpeningReplyVisible}
            onCheckedChange={(checked) => updateSettings({ keepOpeningReplyVisible: checked })}
            aria-label="Keep replies visible"
          />
        }
      />
    </>
  );
}
