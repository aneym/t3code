import * as Layer from "effect/Layer";

import * as PeerClientPairing from "./PeerClientPairing.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinkAutoRenew from "./PeerLinkAutoRenew.ts";
import * as PeerLinkRenewalGrant from "./PeerLinkRenewalGrant.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

export const layer = Layer.mergeAll(
  PeerForwarding.layer,
  PeerClientPairing.layer,
  PeerLinkRenewalGrant.layer,
  PeerLinkAutoRenew.layer,
).pipe(Layer.provideMerge(PeerMcpClient.layer), Layer.provideMerge(PeerLinks.layer));

export const routeLayer = Layer.mergeAll(
  PeerClientPairing.routeLayer,
  PeerLinkRenewalGrant.routeLayer,
);
