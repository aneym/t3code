import type { EnvironmentId } from "@t3tools/contracts";

import { useJoinLinkedRoute, useLinkedRoutePlan } from "../connection/linkedRoutes";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export function RemovedLinkedRoutes(props: {
  readonly hosts: ReadonlyArray<{ readonly environmentId: EnvironmentId }>;
}) {
  return props.hosts.map((host) => (
    <HostRemovedRoutes key={host.environmentId} hostId={host.environmentId} />
  ));
}

function HostRemovedRoutes(props: { readonly hostId: EnvironmentId }) {
  const plan = useLinkedRoutePlan(props.hostId);
  const joinRoute = useJoinLinkedRoute(props.hostId, true);
  if (plan.removed.length === 0) return null;
  return (
    <SettingsSection
      title="Removed from this device"
      footer="Load balancing does not add these machines again. Turn one on to add it back."
    >
      {plan.removed.map((link) => (
        <SettingsSwitchRow
          key={link.environmentId}
          icon="link"
          label={link.label}
          value={false}
          onValueChange={(value) => {
            if (value) void joinRoute(link.environmentId);
          }}
        />
      ))}
    </SettingsSection>
  );
}
