import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

export function PeerLinkRenewalSetting({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const enabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.peerLinkRenewalEnabled,
  );
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save link renewal setting",
  });
  const [saving, setSaving] = useState(false);
  const save = async (next: boolean) => {
    setSaving(true);
    await updateSettings({ environmentId, input: { patch: { peerLinkRenewalEnabled: next } } });
    setSaving(false);
  };
  return (
    <SettingsRow
      title="Renew links without a code"
      description="Linked environments renew for 30 more days in a link's last 7 days, with no pairing code. Each renewal replaces the old session in Authorized clients. Expired or revoked links still need a code."
      control={
        <Switch
          checked={enabled}
          disabled={!canWrite || saving}
          onCheckedChange={(checked) => void save(Boolean(checked))}
          aria-label="Renew links without a code"
        />
      }
    />
  );
}
