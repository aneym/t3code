import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentsWithScope } from "../../../state/session";
import { useSettingsEnvironmentFilter } from "../settings-environment-filter";
import { resolveMobileSettingsTargets, uniformMobileSetting } from "../settings-scoped-server";
import { useSettingsWriter } from "../useSettingsWriter";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export function QueuedInputDeliverySetting() {
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  const writable = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const targets = resolveMobileSettingsTargets(selectedTargets, null);
  const write = useSettingsWriter();
  const [pending, setPending] = useState(false);
  if (selectedProjectKey !== null || targets.length === 0) return null;
  return (
    <SettingsSection title="Open questions">
      <SettingsSwitchRow
        icon="bubble.left.and.bubble.right"
        label="Queued messages answer open questions"
        subtitle="Notify the agent of queued messages so it can end its turn and read them next."
        value={uniformMobileSetting(targets, "queuedMessagesAnswerPendingInput")}
        disabled={
          pending || targets.some((target) => !writable.has(target.environment.environmentId))
        }
        onValueChange={(value) => {
          setPending(true);
          void write(
            targets,
            targets.map((target) => ({
              environmentId: target.environment.environmentId,
              patch: { queuedMessagesAnswerPendingInput: value },
            })),
          ).finally(() => setPending(false));
        }}
      />
    </SettingsSection>
  );
}
