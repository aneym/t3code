import { useAtomValue } from "@effect/atom-react";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import { linkedRoutesToJoin } from "@t3tools/client-runtime/state/peerLinks";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { connectPairingUrl } from "../../connection/onboarding";
import { useEnvironments } from "../../state/environments";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

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
        knownEnvironmentIds={environments.map((known) => known.environmentId)}
      />
    ));
}

function LinkedEnvironmentRoutes(props: {
  readonly environmentId: EnvironmentId;
  readonly knownEnvironmentIds: ReadonlyArray<EnvironmentId>;
}) {
  const allowed = useAtomValue(peerLinkEnvironment.pairClient.permissionAtom(props.environmentId));
  const links = useEnvironmentQuery(
    allowed ? peerLinkEnvironment.list({ environmentId: props.environmentId, input: {} }) : null,
  );
  const pairClient = useAtomCommand(peerLinkEnvironment.pairClient, { reportFailure: false });
  const connect = useAtomCommand(connectPairingUrl, { reportFailure: false });
  const attempted = useRef(new Set<EnvironmentId>());
  const targets = linkedRoutesToJoin(links.data?.links ?? [], new Set(props.knownEnvironmentIds));
  const targetsKey = targets.map((link) => link.environmentId).join("\n");

  const join = useEffectEvent(async () => {
    for (const link of targets) {
      if (attempted.current.has(link.environmentId)) continue;
      attempted.current.add(link.environmentId);
      const issued = await pairClient({
        environmentId: props.environmentId,
        input: { environmentId: link.environmentId },
      });
      if (issued._tag !== "Success") continue;
      await connect({
        pairingUrl: issued.value.pairingUrl,
        expectedEnvironmentId: link.environmentId,
      });
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- adds saved routes for machines the host links once its link list loads
  useEffect(() => {
    if (targetsKey !== "") void join();
  }, [targetsKey]);

  return null;
}
