import {
  HostLinkBindInput,
  HostLinkBindResult,
  HostLinkStatus,
  HostLinkStatusInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import { HostLinkService } from "../../../hostLink/HostLinkService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [HostLinkService, McpInvocationContext, ThreadManagementService],
};

export const HostLinkToolkit = Toolkit.make(
  Tool.make("t3_host_link_bind", {
    ...shared,
    description:
      "Set the host app's lane for a thread, or clear it with lane null. A thread with a lane has its turns, messages, steps and end pushed to the linked host app.",
    parameters: HostLinkBindInput,
    success: HostLinkBindResult,
  })
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
  Tool.make("t3_host_link_status", {
    ...shared,
    description:
      "Show the host app link: on or off, connection state, last heard, unacked events, and each thread's lane.",
    parameters: HostLinkStatusInput,
    success: HostLinkStatus,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
