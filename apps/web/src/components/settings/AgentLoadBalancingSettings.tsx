import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import type { EnvironmentPresentation } from "~/state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { EnvironmentRow } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { ScopedSwitch } from "./ScopedSwitch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const PINNED = -1;
const choices = [
  { value: PINNED, label: "Always here" },
  { value: 100, label: "Prefer" },
  { value: 50, label: "Normal" },
  { value: 25, label: "Less often" },
  { value: 0, label: "Manual only" },
];

export function AgentLoadBalancingSettings({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  return (
    <FoldedSettingsSection
      id="agent-load-balancing"
      title="Agent load balancing"
      summary={settings.agentLoadBalancingEnabled ? "On" : "Off"}
      control={
        <ScopedSwitch
          settingKeys={["agentLoadBalancingEnabled"]}
          checked={settings.agentLoadBalancingEnabled}
          onCheckedChange={(checked) => update({ agentLoadBalancingEnabled: Boolean(checked) })}
          aria-label="Automatically place agent work"
        />
      }
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Agent launches go to the linked machine with this repository, the selected provider, and the
        most weighted free CPU, memory and disk. Machines past their health line are skipped. An
        explicit machine always wins. Preferences apply to launches from the selected server.
      </p>
      {environments.map((environment) => (
        <EnvironmentRow
          key={environment.environmentId}
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          label={environment.label}
          subtitle={null}
        >
          <Select
            items={choices}
            value={
              settings.agentPlacementPinnedEnvironmentId === environment.environmentId
                ? PINNED
                : (settings.agentLoadBalancingWeights[environment.environmentId] ?? 50)
            }
            disabled={!settings.agentLoadBalancingEnabled}
            onValueChange={(value) => {
              if (value === PINNED)
                update({ agentPlacementPinnedEnvironmentId: environment.environmentId });
              else if (value !== null)
                update({
                  agentLoadBalancingWeights: {
                    ...settings.agentLoadBalancingWeights,
                    [environment.environmentId]: value,
                  },
                  ...(settings.agentPlacementPinnedEnvironmentId === environment.environmentId
                    ? { agentPlacementPinnedEnvironmentId: null }
                    : {}),
                });
            }}
          >
            <SelectTrigger
              size="xs"
              className="w-32"
              aria-label={`${environment.label} agent load preference`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {choices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </EnvironmentRow>
      ))}
    </FoldedSettingsSection>
  );
}
