import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerDatabase from "../../../serverDatabase/ServerDatabase.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ServerDatabaseToolkit } from "./tools.ts";

const ownerCli = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.client?.ownerCli === true) return yield* ServerDatabase.ServerDatabase;
  return yield* new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "Only this server owner's t3 CLI can read the server database.",
  });
});

const asToolFailure = (error: ServerDatabase.ServerDatabaseError) =>
  new OrchestratorMcpFailure({ code: error.code, message: error.message });

const withDatabase = <A>(
  use: (
    database: ServerDatabase.ServerDatabase["Service"],
  ) => Effect.Effect<A, ServerDatabase.ServerDatabaseError>,
) =>
  ownerCli.pipe(Effect.flatMap((database) => use(database).pipe(Effect.mapError(asToolFailure))));

export const layer = McpToolAccess.toLayer(ServerDatabaseToolkit, {
  t3_runs_list: McpToolAccess.reads((input) =>
    withDatabase((database) => database.listRuns(input)),
  ),
  t3_db_info: McpToolAccess.reads(() => withDatabase((database) => database.info)),
  t3_db_snapshot: McpToolAccess.reads((input) =>
    withDatabase((database) => database.snapshot(input)),
  ),
});
