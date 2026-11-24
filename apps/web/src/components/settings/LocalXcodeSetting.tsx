import { useRef } from "react";
import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function LocalXcodeSetting() {
  const { scope, targets } = useSettingsScope();
  const value = useScopedSettings().localDeviceDeveloperDir;
  const updateSettings = useUpdateScopedSettings();
  const edited = useRef(false);
  if (scope.kind === "project" || scope.kind === "checkout") return null;
  const mixed =
    targets.length > 1 &&
    targets.some((target) => target.settings.localDeviceDeveloperDir !== value);
  return (
    <SettingsRow
      serverScoped
      settingKeys={["localDeviceDeveloperDir"]}
      title="Xcode for local simulators"
      description="Xcode Developer folder for this Mac's simulators, such as /Applications/Xcode-beta.app/Contents/Developer. Empty uses xcode-select. Changing it restarts agent device tools."
      resetAction={
        mixed || value !== "" ? (
          <SettingResetButton
            label="Xcode for local simulators"
            onClick={() => updateSettings({ localDeviceDeveloperDir: "" })}
          />
        ) : null
      }
      control={
        <Input
          key={`${mixed}:${value}`}
          aria-label="Xcode developer folder"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={mixed ? "Mixed" : "xcode-select default"}
          defaultValue={mixed ? "" : value}
          onChange={() => {
            edited.current = true;
          }}
          onBlur={(event) => {
            const next = event.target.value.trim();
            if (edited.current && (mixed || next !== value))
              updateSettings({ localDeviceDeveloperDir: next });
            edited.current = false;
          }}
        />
      }
    />
  );
}
