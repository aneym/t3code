import { useAtomValue } from "@effect/atom-react";
import { linkedRoutePlan } from "@t3tools/client-runtime/state/peerLinks";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectPairingUrl } from "../../connection/onboarding";
import { useEnvironments } from "../../state/environments";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const NO_SEEN_ENVIRONMENTS: readonly EnvironmentId[] = [];

export function useLinkedRoutePlan(hostId: EnvironmentId) {
  const allowed = useAtomValue(peerLinkEnvironment.pairClient.permissionAtom(hostId));
  const links = useEnvironmentQuery(
    allowed ? peerLinkEnvironment.list({ environmentId: hostId, input: {} }) : null,
  );
  const { environments } = useEnvironments();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const seen =
    preferences._tag === "Success"
      ? (preferences.value.loadBalancingSeenLinkedEnvironmentIds ?? NO_SEEN_ENVIRONMENTS)
      : NO_SEEN_ENVIRONMENTS;
  const known = new Set(environments.map((environment) => environment.environmentId));
  return { ...linkedRoutePlan(links.data?.links ?? [], known, new Set(seen)), seen };
}

export function useJoinLinkedRoute(hostId: EnvironmentId, reportFailure: boolean) {
  const pairClient = useAtomCommand(peerLinkEnvironment.pairClient, { reportFailure });
  const connect = useAtomCommand(connectPairingUrl, { reportFailure });
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
