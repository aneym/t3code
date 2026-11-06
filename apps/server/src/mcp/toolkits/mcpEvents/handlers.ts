import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { McpEventsService } from "../../../mcpEvents/McpEventsService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { McpEventsToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(McpEventsToolkit, {
  t3_events_subscribe: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const threadId = input.threadId ?? scope.thread?.threadId;
      if (threadId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: "Pass threadId; this caller has no thread.",
        });
      }
      return yield* Effect.flatMap(McpEventsService, (service) =>
        service.subscribe({ ...input, threadId }),
      );
    }),
  ),
  t3_events_list: McpToolAccess.either(
    (input) => input.server === undefined,
    McpToolAccess.reads((input) =>
      Effect.flatMap(McpEventsService, (service) => service.list(input)),
    ),
    McpToolAccess.writesEnvironment((input) =>
      Effect.flatMap(McpEventsService, (service) => service.list(input)),
    ),
  ),
  t3_events_unsubscribe: McpToolAccess.writesEnvironment((input) =>
    Effect.flatMap(McpEventsService, (service) => service.unsubscribe(input.subscriptionId)),
  ),
});
