import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { HostLinkService } from "../../../hostLink/HostLinkService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HostLinkToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(HostLinkToolkit, {
  t3_host_link_bind: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const threadId = input.threadId ?? scope.thread?.threadId;
      if (threadId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: "Pass threadId; this caller has no thread.",
        });
      }
      return yield* Effect.flatMap(HostLinkService, (service) =>
        service.bind({ threadId, lane: input.lane }),
      );
    }),
  ),
  t3_host_link_status: McpToolAccess.reads((input) =>
    Effect.flatMap(HostLinkService, (service) =>
      service.status(input.threadId === undefined ? {} : { threadId: input.threadId }),
    ),
  ),
});
