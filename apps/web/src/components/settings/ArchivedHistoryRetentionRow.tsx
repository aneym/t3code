import { AnimatedHeight } from "../AnimatedHeight";
import { RetentionControl } from "./RetentionControl";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function ArchivedHistoryRetentionRow() {
  const { connectedEnvironments, targets } = useSettingsScope();
  const value = useScopedSettings().storageCleanup.archivedHistoryAfterDays;
  const updateSettings = useUpdateScopedSettings();
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (environment) =>
        environment.serverConfig?.environment.capabilities.archivedHistoryRetention === true,
    );
  if (!supported) return null;
  const mixed =
    targets.length > 1 &&
    targets.some((target) => target.settings.storageCleanup.archivedHistoryAfterDays !== value);
  return (
    <AnimatedHeight>
      <SettingsRow
        title="Trim archived thread history"
        status={mixed ? "Mixed across selected machines" : undefined}
        managedPaths={["storageCleanup.archivedHistoryAfterDays"]}
        description="Removes tool output and agent work from threads archived this long. Messages stay. This cannot be undone."
        serverScoped
        control={
          <RetentionControl
            label="Trim archived thread history"
            value={value}
            initial={30}
            onChange={(archivedHistoryAfterDays, onFailed) =>
              updateSettings({ storageCleanup: { archivedHistoryAfterDays } }, { onFailed })
            }
          />
        }
      />
    </AnimatedHeight>
  );
}
