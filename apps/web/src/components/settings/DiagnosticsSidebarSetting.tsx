import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function DiagnosticsSidebarSetting() {
  const enabled = useClientSettings((settings) => settings.showDiagnosticsInSidebar);
  return (
    <SettingsSection title="Sidebar">
      <SettingsRow
        title="Show Diagnostics in sidebar"
        description="Open machine diagnostics from the sidebar."
        control={
          <Switch
            aria-label="Show Diagnostics in sidebar"
            checked={enabled}
            onCheckedChange={(checked) =>
              void updateClientSettings({ showDiagnosticsInSidebar: checked })
            }
          />
        }
      />
    </SettingsSection>
  );
}
