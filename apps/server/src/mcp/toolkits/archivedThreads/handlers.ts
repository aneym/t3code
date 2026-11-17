import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ArchivedHistoryRetention from "../../../orchestration-v2/ArchivedHistoryRetention.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { ArchivedThreadsToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ArchivedThreadsToolkit, {
  t3_thread_archived: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const retention = yield* Effect.serviceOption(
        ArchivedHistoryRetention.ArchivedHistoryRetention,
      );
      if (Option.isNone(retention)) return yield* unavailable();
      return yield* retention.value
        .list(input)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
    }),
  ),
});
