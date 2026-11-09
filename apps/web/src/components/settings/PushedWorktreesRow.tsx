import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function PushedWorktreesRow() {
  const { connectedEnvironments, targets } = useSettingsScope();
  const settings = useScopedSettings().storageCleanup;
  const updateSettings = useUpdateScopedSettings();
  if (
    connectedEnvironments.length === 0 ||
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.worktreeAcceptPushed !== true,
    )
  )
    return null;
  const mixed = targets.some(
    (target) =>
      target.settings.storageCleanup.worktreeAcceptPushed !== settings.worktreeAcceptPushed,
  );
  return (
    <SettingsRow
      title="Count pushed branches as safe"
      status={mixed ? "Mixed across selected machines" : undefined}
      description="A clean worktree whose commits are all on the remote can be removed even if its branch hasn't landed or was renamed. Reopening the thread recreates it from the branch. Orphaned worktrees wait as long as settled ones."
      serverScoped
      control={
        <Switch
          aria-label="Count pushed branches as safe"
          checked={settings.worktreeAcceptPushed}
          onCheckedChange={(worktreeAcceptPushed) =>
            updateSettings({ storageCleanup: { worktreeAcceptPushed } })
          }
        />
      }
    />
  );
}
