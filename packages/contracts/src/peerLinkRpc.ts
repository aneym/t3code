import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  PeerLink,
  PeerLinkCreateInput,
  PeerLinkError,
  PeerLinkPairClientInput,
  PeerLinkPairClientResult,
  PeerLinkRemoveInput,
  PeerLinkRemoveResult,
  PeerLinkRequestAnswerInput,
  PeerLinkRequestError,
  PeerLinkSummary,
} from "./peerLink.ts";

export const PEER_LINK_WS_METHODS = {
  peerLinksList: "peerLinks.list",
  peerLinksLink: "peerLinks.link",
  peerLinksUnlink: "peerLinks.unlink",
  peerLinksAnswerRequest: "peerLinks.answerRequest",
  peerLinksPairClient: "peerLinks.pairClient",
} as const;

const PeerLinkRpcError = Schema.Union([PeerLinkError, EnvironmentAuthorizationError]);

export const PeerLinkRpcs = [
  Rpc.make(PEER_LINK_WS_METHODS.peerLinksList, {
    payload: Schema.Struct({}),
    success: Schema.Struct({ links: Schema.Array(PeerLinkSummary) }),
    error: PeerLinkRpcError,
  }),
  Rpc.make(PEER_LINK_WS_METHODS.peerLinksLink, {
    payload: PeerLinkCreateInput,
    success: PeerLink,
    error: PeerLinkRpcError,
  }),
  Rpc.make(PEER_LINK_WS_METHODS.peerLinksUnlink, {
    payload: PeerLinkRemoveInput,
    success: PeerLinkRemoveResult,
    error: PeerLinkRpcError,
  }),
  Rpc.make(PEER_LINK_WS_METHODS.peerLinksAnswerRequest, {
    payload: PeerLinkRequestAnswerInput,
    error: Schema.Union([PeerLinkRequestError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(PEER_LINK_WS_METHODS.peerLinksPairClient, {
    payload: PeerLinkPairClientInput,
    success: PeerLinkPairClientResult,
    error: PeerLinkRpcError,
  }),
] as const;
