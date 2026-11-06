import type { EnvironmentId, ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";

const choices = [
  { label: "Prefer", weight: 100 },
  { label: "Normal", weight: 50 },
  { label: "Less often", weight: 25 },
  { label: "Manual only", weight: 0 },
];

export function AgentLoadBalancingSettings(props: {
  readonly environments: readonly {
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
  }[];
  readonly settings: ServerSettings;
  readonly disabled: boolean;
  readonly update: (patch: ServerSettingsPatch) => void;
}) {
  return (
    <>
      <SettingsSection
        title="Agent load balancing"
        footer="Agent launches choose a linked machine with this repository, the selected provider, and free CPU and memory. An explicit machine always wins."
      >
        <SettingsSwitchRow
          label="Automatically place agent work"
          value={props.settings.agentLoadBalancingEnabled}
          disabled={props.disabled}
          onValueChange={(agentLoadBalancingEnabled) => props.update({ agentLoadBalancingEnabled })}
        />
      </SettingsSection>
      {props.environments.map((environment) => (
        <SettingsSection
          key={environment.environmentId}
          title={`${environment.environmentLabel} agent preference`}
        >
          {choices.map((choice, index) => (
            <ListChoiceRow
              key={choice.weight}
              label={choice.label}
              separated={index > 0}
              disabled={props.disabled || !props.settings.agentLoadBalancingEnabled}
              selected={
                (props.settings.agentLoadBalancingWeights[environment.environmentId] ?? 50) ===
                choice.weight
              }
              onPress={() =>
                props.update({
                  agentLoadBalancingWeights: {
                    ...props.settings.agentLoadBalancingWeights,
                    [environment.environmentId]: choice.weight,
                  },
                })
              }
            />
          ))}
        </SettingsSection>
      ))}
    </>
  );
}
