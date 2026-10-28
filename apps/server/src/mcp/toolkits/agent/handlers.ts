import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AgentHomeService } from "../../../agents/AgentHomeService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { AgentToolkit } from "./tools.ts";
export const layer = McpToolAccess.toLayer(AgentToolkit, {
  t3_agent_list: McpToolAccess.reads(() =>
    Effect.flatMap(AgentHomeService, (service) => service.list).pipe(Effect.mapError(unavailable)),
  ),
  t3_agent_bind: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const service = yield* AgentHomeService;
      return yield* service
        .bind(input)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
    }),
  ),
});
