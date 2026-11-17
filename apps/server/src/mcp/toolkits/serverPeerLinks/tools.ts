import {
  OrchestratorMcpFailure,
  PeerLink,
  PeerLinkCreateInput,
  PeerLinkListResult,
  PeerLinkRemoveInput,
  PeerLinkRemoveResult,
  PeerLinkRenewInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, PeerLinks.PeerLinks],
};

const PeerLinkListTool = Tool.make("t3_peer_link_list", {
  ...shared,
  description: "Owner CLI only. List this server's linked environments and whether each answers.",
  success: PeerLinkListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const PeerLinkCreateTool = Tool.make("t3_peer_link_create", {
  ...shared,
  description: "Owner CLI only. Link another environment with a pairing code from it.",
  parameters: PeerLinkCreateInput,
  success: PeerLink,
}).annotate(Tool.Destructive, false);

const PeerLinkUnlinkTool = Tool.make("t3_peer_link_unlink", {
  ...shared,
  description: "Owner CLI only. Forget a linked environment here.",
  parameters: PeerLinkRemoveInput,
  success: PeerLinkRemoveResult,
}).annotate(Tool.Destructive, true);

const PeerLinkRenewTool = Tool.make("t3_peer_link_renew", {
  ...shared,
  description: "Owner CLI only. Renew a linked environment for 30 more days in its last 7 days.",
  parameters: PeerLinkRenewInput,
  success: PeerLink,
}).annotate(Tool.Destructive, false);

export const ServerPeerLinksToolkit = Toolkit.make(
  PeerLinkListTool,
  PeerLinkCreateTool,
  PeerLinkUnlinkTool,
  PeerLinkRenewTool,
);
