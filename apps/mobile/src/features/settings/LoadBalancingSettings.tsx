import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";

const WEIGHTS = [
  { label: "Prefer", weight: 100 },
  { label: "Normal", weight: 50 },
  { label: "Less often", weight: 25 },
  { label: "Manual only", weight: 0 },
];

export function LoadBalancingSettings(props: {
  readonly environments: readonly {
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
  }[];
}) {
  const result = useAtomValue(mobilePreferencesAtom);
  const update = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const preferences = result._tag === "Success" ? result.value : null;
  if (props.environments.length === 0) return null;
  const enabled = preferences?.loadBalancingEnabled === true;
  return (
    <>
      <SettingsSection
        title="Load balancing"
        footer="Shared-project new threads use free CPU and memory, weighted by each machine’s preference."
      >
        <SettingsSwitchRow
          label="Automatically balance new threads"
          value={enabled}
          disabled={preferences === null}
          onValueChange={(loadBalancingEnabled) => {
            void update({ loadBalancingEnabled });
          }}
        />
      </SettingsSection>
      {props.environments.map((environment) => (
        <SettingsSection key={environment.environmentId} title={environment.environmentLabel}>
          {WEIGHTS.map((choice, index) => (
            <ListChoiceRow
              key={choice.weight}
              label={choice.label}
              selected={
                (preferences?.loadBalancingWeights?.[environment.environmentId] ?? 50) ===
                choice.weight
              }
              separated={index > 0}
              disabled={!enabled || preferences === null}
              onPress={() => {
                void update({
                  transform: (current) => ({
                    loadBalancingWeights: {
                      ...current.loadBalancingWeights,
                      [environment.environmentId]: choice.weight,
                    },
                  }),
                });
              }}
            />
          ))}
        </SettingsSection>
      ))}
    </>
  );
}
