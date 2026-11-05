import type { ServerSettingsPatch } from "@t3tools/contracts";

import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

type PreviewBrowserKey = "enableAgentBrowserAccess" | "previewOpenOnUserDevice";

export function PreviewBrowserSettingsSection(props: {
  readonly uniform: (key: PreviewBrowserKey) => boolean | null;
  readonly managedSubtitle: (key: PreviewBrowserKey, subtitle: string) => string;
  readonly disabledFor: (key: PreviewBrowserKey) => boolean;
  readonly write: (patch: ServerSettingsPatch) => void;
}) {
  const { uniform, managedSubtitle, disabledFor, write } = props;
  return (
    <SettingsSection title="Preview browser">
      <SettingsSwitchRow
        icon="globe"
        label="Agent browser access"
        subtitle={managedSubtitle(
          "enableAgentBrowserAccess",
          "Allow agents to use the in-app preview browser.",
        )}
        value={uniform("enableAgentBrowserAccess")}
        disabled={disabledFor("enableAgentBrowserAccess")}
        onValueChange={(value) => write({ enableAgentBrowserAccess: value })}
      />
      <SettingsSwitchRow
        icon="desktopcomputer"
        label="Open agent tabs on your desktop"
        subtitle={managedSubtitle(
          "previewOpenOnUserDevice",
          "Show agent tabs on the connected desktop app you used last. Otherwise they open in this environment's browser.",
        )}
        value={uniform("previewOpenOnUserDevice")}
        disabled={disabledFor("previewOpenOnUserDevice")}
        onValueChange={(value) => write({ previewOpenOnUserDevice: value })}
      />
    </SettingsSection>
  );
}
