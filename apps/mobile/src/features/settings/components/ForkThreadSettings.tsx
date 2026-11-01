import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentsWithScope } from "../../../state/session";
import { useSettingsEnvironmentFilter } from "../settings-environment-filter";
import { resolveMobileSettingsTargets, uniformMobileSetting } from "../settings-scoped-server";
import { useSettingsWriter } from "../useSettingsWriter";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export function ForkThreadSettings() {
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  const writable = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const targets = resolveMobileSettingsTargets(selectedTargets, null);
  const write = useSettingsWriter();
  const [pending, setPending] = useState(false);
  if (selectedProjectKey !== null || targets.length === 0) return null;
  return (
    <>
      {[
        {
          key: "queuedMessagesAnswerPendingInput",
          title: "Open questions",
          label: "Queued messages answer open questions",
          subtitle:
            "Notify the agent of queued messages so it can end its turn and read them next.",
          icon: "bubble.left.and.bubble.right",
        },
        {
          key: "settleIdleChildren",
          title: "Child threads",
          label: "Settle idle child threads",
          subtitle:
            "Settle idle children of settled parents. Keep running, waiting, pinned, snoozed, and explicitly active children open.",
          icon: "checkmark.circle",
        },
      ].map(({ key, title, label, subtitle, icon }) => {
        const settingKey = key as "queuedMessagesAnswerPendingInput" | "settleIdleChildren";
        return (
          <SettingsSection key={key} title={title}>
            <SettingsSwitchRow
              icon={icon as "bubble.left.and.bubble.right" | "checkmark.circle"}
              label={label}
              subtitle={subtitle}
              value={uniformMobileSetting(targets, settingKey)}
              disabled={
                pending || targets.some((target) => !writable.has(target.environment.environmentId))
              }
              onValueChange={(value) => {
                setPending(true);
                void write(
                  targets,
                  targets.map((target) => ({
                    environmentId: target.environment.environmentId,
                    patch: { [settingKey]: value },
                  })),
                ).finally(() => setPending(false));
              }}
            />
          </SettingsSection>
        );
      })}
    </>
  );
}
