import {
  ArchivedThreadsListInput,
  ArchivedThreadsListResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ArchivedThreadsTool = Tool.make("t3_thread_archived", {
  description:
    "List archived threads oldest first with payload bytes and a history-trim verdict: `due` (would be trimmed), `kept` (see `keptReason`), `trimmed`, or `not-due` (newer than the cutoff or nothing to remove). Read-only; with `storageCleanup.archivedHistoryAfterDays` off it is the dry run. `olderThanDays` overrides the setting. Page with `nextCursor`.",
  parameters: ArchivedThreadsListInput,
  success: ArchivedThreadsListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "List archived threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ArchivedThreadsToolkit = Toolkit.make(ArchivedThreadsTool);
