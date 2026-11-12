import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { useEnvironments } from "../../state/environments";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useJoinLinkedRoute, useLinkedRoutePlan } from "./linkedRoutes";

export function LinkedEnvironmentRoutesCoordinator() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const { environments } = useEnvironments();
  if (preferences._tag !== "Success" || preferences.value.loadBalancingEnabled !== true) {
    return null;
  }
  return environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        offersLinkedEnvironments(environment.serverConfig) &&
        environment.serverConfig?.settings.loadBalancingIncludeLinkedEnvironments === true,
    )
    .map((environment) => (
      <LinkedEnvironmentRoutes
        key={environment.environmentId}
        environmentId={environment.environmentId}
      />
    ));
}

function LinkedEnvironmentRoutes(props: { readonly environmentId: EnvironmentId }) {
  const plan = useLinkedRoutePlan(props.environmentId);
  const joinRoute = useJoinLinkedRoute(props.environmentId, false);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const attempted = useRef(new Set<EnvironmentId>());
  const planKey = [...plan.newlySeen, "", ...plan.join.map((link) => link.environmentId)].join(
    "\n",
  );

  const apply = useEffectEvent(async () => {
    if (plan.newlySeen.length > 0) {
      const newlySeen = plan.newlySeen;
      await savePreferences({
        transform: (current) => ({
          loadBalancingSeenLinkedEnvironmentIds: [
            ...new Set([...(current.loadBalancingSeenLinkedEnvironmentIds ?? []), ...newlySeen]),
          ],
        }),
      });
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
