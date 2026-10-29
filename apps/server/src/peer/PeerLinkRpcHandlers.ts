import {
  type PeerLinkCreateInput,
  type PeerLinkPairClientInput,
  type PeerLinkRemoveInput,
  type PeerLinkRequestAnswerInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PeerClientPairing from "./PeerClientPairing.ts";
import * as PeerLinkRequests from "./PeerLinkRequests.ts";
import * as PeerLinks from "./PeerLinks.ts";

export const make = Effect.gen(function* () {
  const peerLinks = yield* PeerLinks.PeerLinks;
  const peerLinkRequests = yield* PeerLinkRequests.PeerLinkRequests;
  const pairing = yield* PeerClientPairing.PeerClientPairing;
  return {
    [WS_METHODS.peerLinksList]: (_input: object) =>
      peerLinks.list.pipe(Effect.map((links) => ({ links }))),
    [WS_METHODS.peerLinksLink]: (input: PeerLinkCreateInput) => peerLinks.link(input),
    [WS_METHODS.peerLinksUnlink]: ({ environmentId }: PeerLinkRemoveInput) =>
      peerLinks.unlink(environmentId).pipe(Effect.map((removed) => ({ removed }))),
    [WS_METHODS.peerLinksAnswerRequest]: (input: PeerLinkRequestAnswerInput) =>
      Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
        Effect.andThen(peerLinkRequests.answer(input)),
      ),
    [WS_METHODS.peerLinksPairClient]: ({ environmentId }: PeerLinkPairClientInput) =>
      pairing.pairClient(environmentId),
  };
});
