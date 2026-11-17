import { OrchestratorMcpFailure, type PeerLinkError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ServerPeerLinksToolkit } from "./tools.ts";

const ownerCli = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.client?.ownerCli === true) return yield* PeerLinks.PeerLinks;
  return yield* new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "Only this server owner's t3 CLI can manage its linked environments.",
  });
});

const withLinks = <A>(
  use: (links: PeerLinks.PeerLinks["Service"]) => Effect.Effect<A, PeerLinkError>,
) =>
  ownerCli.pipe(
    Effect.flatMap((links) =>
      use(links).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
      ),
    ),
  );

export const layer = McpToolAccess.toLayer(ServerPeerLinksToolkit, {
  t3_peer_link_list: McpToolAccess.reads(() =>
    withLinks((links) => Effect.map(links.list, (listed) => ({ links: listed }))),
  ),
  t3_peer_link_create: McpToolAccess.reads((input) => withLinks((links) => links.link(input))),
  t3_peer_link_unlink: McpToolAccess.reads(({ environmentId }) =>
    withLinks((links) => Effect.map(links.unlink(environmentId), (removed) => ({ removed }))),
  ),
  t3_peer_link_renew: McpToolAccess.reads(({ environmentId }) =>
    withLinks((links) => links.renew(environmentId)),
  ),
});
