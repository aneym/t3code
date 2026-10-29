import { useAtomValue } from "@effect/atom-react";
import { linkedRoutesToJoin } from "@t3tools/client-runtime/state/peerLinks";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { connectPairing } from "../connection/onboarding";
import { useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { peerLinkEnvironment, usePeerLinkHosts } from "../state/peerLinks";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";

export function LinkedEnvironmentRoutesCoordinator() {
  const loadBalancingEnabled = useClientSettings((settings) => settings.loadBalancingEnabled);
  const hosts = usePeerLinkHosts();
  if (!loadBalancingEnabled) return null;
  return hosts
    .filter((host) => host.serverConfig?.settings.loadBalancingIncludeLinkedEnvironments === true)
    .map((host) => (
      <LinkedEnvironmentRoutes key={host.environmentId} environmentId={host.environmentId} />
    ));
}

function LinkedEnvironmentRoutes(props: { readonly environmentId: EnvironmentId }) {
  const allowed = useAtomValue(peerLinkEnvironment.pairClient.permissionAtom(props.environmentId));
  const links = useEnvironmentQuery(
    allowed ? peerLinkEnvironment.list({ environmentId: props.environmentId, input: {} }) : null,
  );
  const knownEnvironmentIds = new Set(useEnvironmentIds());
  const pairClient = useAtomCommand(peerLinkEnvironment.pairClient, { reportFailure: false });
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const attempted = useRef(new Set<EnvironmentId>());
  const targets = linkedRoutesToJoin(links.data?.links ?? [], knownEnvironmentIds);
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
