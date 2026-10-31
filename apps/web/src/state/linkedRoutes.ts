import { useAtomValue } from "@effect/atom-react";
import { linkedRoutePlan } from "@t3tools/client-runtime/state/peerLinks";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectPairing } from "../connection/onboarding";
import { useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "./environments";
import { peerLinkEnvironment } from "./peerLinks";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export function useLinkedRoutePlan(hostId: EnvironmentId) {
  const allowed = useAtomValue(peerLinkEnvironment.pairClient.permissionAtom(hostId));
  const links = useEnvironmentQuery(
    allowed ? peerLinkEnvironment.list({ environmentId: hostId, input: {} }) : null,
  );
  const known = new Set(useEnvironmentIds());
  const seen = useClientSettings((settings) => settings.loadBalancingSeenLinkedEnvironmentIds);
  return { ...linkedRoutePlan(links.data?.links ?? [], known, new Set(seen)), seen };
}

export function useJoinLinkedRoute(hostId: EnvironmentId, reportFailure: boolean) {
  const pairClient = useAtomCommand(peerLinkEnvironment.pairClient, { reportFailure });
  const connect = useAtomCommand(connectPairing, { reportFailure });
  return async (environmentId: EnvironmentId) => {
    const issued = await pairClient({ environmentId: hostId, input: { environmentId } });
    if (issued._tag !== "Success") return false;
    const connected = await connect({
      pairingUrl: issued.value.pairingUrl,
      expectedEnvironmentId: environmentId,
    });
    return connected._tag === "Success";
  };
}
