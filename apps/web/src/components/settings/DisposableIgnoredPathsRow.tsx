import { useRef } from "react";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const parsePaths = (value: string) =>
  [...new Set(value.split(/[,\n]/).map((pattern) => pattern.trim()))].filter(Boolean).slice(0, 50);

export function DisposableIgnoredPathsRow() {
  const { connectedEnvironments, targets } = useSettingsScope();
  const settings = useScopedSettings().storageCleanup;
  const updateSettings = useUpdateScopedSettings();
  const edited = useRef(false);
  if (
    connectedEnvironments.length === 0 ||
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.worktreeDisposableIgnoredPaths !==
        true,
    )
  )
    return null;
  const saved = settings.worktreeDisposableIgnoredPaths.join(", ");
  const mixed = targets.some(
    (target) => target.settings.storageCleanup.worktreeDisposableIgnoredPaths.join(", ") !== saved,
  );
  return (
    <SettingsRow
      title="Disposable ignored paths"
      status={mixed ? "Mixed across selected machines" : undefined}
      description="Excluded files matching these globs, such as **/node_modules/**, no longer keep a worktree. Separate patterns with commas."
      serverScoped
      control={
        <Input
          key={`${targets.map((target) => target.environmentId).join(",")}:${mixed}:${saved}`}
          aria-label="Disposable ignored paths"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={mixed ? "Mixed" : "None"}
          defaultValue={mixed ? "" : saved}
          onChange={() => {
            edited.current = true;
          }}
          onBlur={(event) => {
            const next = parsePaths(event.target.value);
            if (edited.current && (mixed || next.join(", ") !== saved))
              updateSettings({ storageCleanup: { worktreeDisposableIgnoredPaths: next } });
            edited.current = false;
          }}
        />
      }
    />
  );
}
