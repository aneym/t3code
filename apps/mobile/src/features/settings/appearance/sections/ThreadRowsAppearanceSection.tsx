import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";

export function ThreadRowsAppearanceSection() {
  const result = useAtomValue(mobilePreferencesAtom);
  const update = useAtomSet(updateMobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(result) ? result.value : null;
  const disabled = !AsyncResult.isSuccess(result);

  return (
    <SettingsSection title="Thread rows">
      <SettingsSwitchRow
        disabled={disabled}
        icon="desktopcomputer"
        label="Show machine in thread rows"
        subtitle="Show which machine each thread is running on. Hidden details remain in the row long-press menu."
        value={
          preferences?.sidebarThreadShowMachine ?? DEFAULT_UNIFIED_SETTINGS.sidebarThreadShowMachine
        }
        onValueChange={(sidebarThreadShowMachine) => update({ sidebarThreadShowMachine })}
      />
      <SettingsSwitchRow
        disabled={disabled}
        icon="person.crop.circle"
        label="Show agent in thread rows"
        subtitle="Show the current agent and handoff history. Hidden details remain in the row long-press menu."
        value={
          preferences?.sidebarThreadShowAgent ?? DEFAULT_UNIFIED_SETTINGS.sidebarThreadShowAgent
        }
        onValueChange={(sidebarThreadShowAgent) => update({ sidebarThreadShowAgent })}
      />
      <SettingsSwitchRow
        disabled={disabled}
        icon="clock"
        label="Show status text and working time"
        subtitle="Show status labels and working time beside the status icon. Hidden details remain in the row long-press menu."
        value={
          preferences?.sidebarThreadShowStatusText ??
          DEFAULT_UNIFIED_SETTINGS.sidebarThreadShowStatusText
        }
        onValueChange={(sidebarThreadShowStatusText) => update({ sidebarThreadShowStatusText })}
      />
    </SettingsSection>
  );
}
