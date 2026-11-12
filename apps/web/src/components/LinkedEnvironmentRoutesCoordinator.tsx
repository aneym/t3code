import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import {
  persistClientSettingsUpdate,
  useClientSettings,
  useClientSettingsHydrated,
} from "../hooks/useSettings";
import { useJoinLinkedRoute, useLinkedRoutePlan } from "../state/linkedRoutes";
import { usePeerLinkHosts } from "../state/peerLinks";

export function LinkedEnvironmentRoutesCoordinator() {
  const loadBalancingEnabled = useClientSettings((settings) => settings.loadBalancingEnabled);
  const hydrated = useClientSettingsHydrated();
  const hosts = usePeerLinkHosts();
  if (!loadBalancingEnabled || !hydrated) return null;
  return hosts
    .filter((host) => host.serverConfig?.settings.loadBalancingIncludeLinkedEnvironments === true)
    .map((host) => (
      <LinkedEnvironmentRoutes key={host.environmentId} environmentId={host.environmentId} />
    ));
}

function LinkedEnvironmentRoutes(props: { readonly environmentId: EnvironmentId }) {
  const plan = useLinkedRoutePlan(props.environmentId);
  const joinRoute = useJoinLinkedRoute(props.environmentId, false);
  const attempted = useRef(new Set<EnvironmentId>());
  const planKey = [...plan.newlySeen, "", ...plan.join.map((link) => link.environmentId)].join(
    "\n",
  );

  const apply = useEffectEvent(async () => {
    if (plan.newlySeen.length > 0) {
      const newlySeen = plan.newlySeen;
      void persistClientSettingsUpdate((current) => ({
        ...current,
        loadBalancingSeenLinkedEnvironmentIds: [
          ...new Set([...current.loadBalancingSeenLinkedEnvironmentIds, ...newlySeen]),
        ],
      }));
    }
    for (const link of plan.join) {
      if (attempted.current.has(link.environmentId)) continue;
      attempted.current.add(link.environmentId);
      await joinRoute(link.environmentId);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pairs with machines the host links once its link list loads
  useEffect(() => {
    if (planKey !== "") void apply();
  }, [planKey]);

  return null;
}
