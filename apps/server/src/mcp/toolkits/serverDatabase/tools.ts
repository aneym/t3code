import {
  OrchestratorMcpFailure,
  ServerDatabaseInfo,
  ServerDatabaseSnapshotInput,
  ServerDatabaseSnapshotManifest,
  ServerRunsListInput,
  ServerRunsListResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ServerDatabase from "../../../serverDatabase/ServerDatabase.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, ServerDatabase.ServerDatabase],
};

const RunsListTool = Tool.make("t3_runs_list", {
  ...shared,
  description:
    "Owner CLI only. List runs from the server's database: every open run, the runs with these ids, or one thread's runs.",
  parameters: ServerRunsListInput,
  success: ServerRunsListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const DbInfoTool = Tool.make("t3_db_info", {
  ...shared,
  description:
    "Owner CLI only. Read the server database's migration history, identity and size from one read transaction.",
  success: ServerDatabaseInfo,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const DbSnapshotTool = Tool.make("t3_db_snapshot", {
  ...shared,
  description:
    "Owner CLI only. Write a consistent copy of the server's database, or only its thread and message keys, to a new file outside the server's data.",
  parameters: ServerDatabaseSnapshotInput,
  success: ServerDatabaseSnapshotManifest,
}).annotate(Tool.Destructive, false);

export const ServerDatabaseToolkit = Toolkit.make(RunsListTool, DbInfoTool, DbSnapshotTool);
