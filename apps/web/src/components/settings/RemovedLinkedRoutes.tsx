import type { EnvironmentId } from "@t3tools/contracts";

import { useJoinLinkedRoute, useLinkedRoutePlan } from "~/state/linkedRoutes";
import { usePeerLinkHosts } from "~/state/peerLinks";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

export function RemovedLinkedRoutes() {
  const hosts = usePeerLinkHosts();
  return hosts
    .filter((host) => host.serverConfig?.settings.loadBalancingIncludeLinkedEnvironments === true)
    .map((host) => <HostRemovedRoutes key={host.environmentId} hostId={host.environmentId} />);
}

function HostRemovedRoutes(props: { readonly hostId: EnvironmentId }) {
  const plan = useLinkedRoutePlan(props.hostId);
  const joinRoute = useJoinLinkedRoute(props.hostId, true);
  return plan.removed.map((link) => (
    <SettingsRow
      key={link.environmentId}
      title={link.label}
      description="You removed this machine's route here, so load balancing does not add it again."
      control={
        <Button size="sm" variant="outline" onClick={() => void joinRoute(link.environmentId)}>
          Add back
        </Button>
      }
    />
  ));
}
