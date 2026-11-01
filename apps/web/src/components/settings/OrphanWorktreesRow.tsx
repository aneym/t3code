import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function OrphanWorktreesRow() {
  const { connectedEnvironments, targets } = useSettingsScope();
  const settings = useScopedSettings().storageCleanup;
  const updateSettings = useUpdateScopedSettings();
  if (
    connectedEnvironments.length === 0 ||
    connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.worktreeOrphans !== true,
    )
  )
    return null;
  const mixed = targets.some(
    (target) => target.settings.storageCleanup.worktreeOrphans !== settings.worktreeOrphans,
  );
  return (
    <SettingsRow
      title="Delete orphaned worktrees"
      status={mixed ? "Mixed across selected machines" : undefined}
      description="Remove clean, published or landed worktrees that no thread references. Worktrees modified in the last hour, locked worktrees and worktrees still in use are kept."
      serverScoped
      control={
        <Switch
          aria-label="Delete orphaned worktrees"
          checked={settings.worktreeOrphans}
          onCheckedChange={(worktreeOrphans) =>
            updateSettings({ storageCleanup: { worktreeOrphans } })
          }
        />
      }
    />
  );
}
