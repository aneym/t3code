import type {
  OrchestrationV2ThreadShell,
  OrchestratorMcpThreadListInput,
  ProjectId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";

import { isSnoozed } from "../orchestration-v2/AutoSettlementPolicy.ts";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";
import { threadSettlement } from "./threadSettlement.ts";

const DEFAULT_THREAD_LIST_LIMIT = 10;

// Awaited background work keeps a thread live after its turn ends, as auto-settle and the sidebar treat it.
export function listedThreadStatus(shell: OrchestrationV2ThreadShell) {
  if (shell.activityRunStatus != null) return shell.activityRunStatus;
  return backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? [])
    ? "waiting"
    : shell.status;
}

export const listThreadPage = Effect.fn("OrchestratorMcpService.listThreadPage")(function* (
  threadManagement: ThreadManagementServiceShape,
  input: OrchestratorMcpThreadListInput,
  projectId: ProjectId | null,
  nowMs: number,
) {
  const statuses =
    input.statuses === undefined || input.statuses.length === 0 ? null : new Set(input.statuses);
  const titleContains = input.titleContains?.toLocaleLowerCase();
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? DEFAULT_THREAD_LIST_LIMIT;
  const onlySubagents = input.onlySubagents === true;
  const query = {
    projectId: projectId ?? undefined,
    includeSubagents: input.includeSubagents === true || onlySubagents,
  };
  const page =
    statuses === null &&
    input.settled === undefined &&
    input.snoozed === undefined &&
    titleContains === undefined
      ? threadManagement.listProjectThreadPage({ ...query, onlySubagents, cursor, limit })
      : threadManagement.listProjectThreads(query).pipe(
          Effect.map((threads) => {
            const filtered = threads.filter(
              (thread) =>
                (statuses === null || statuses.has(listedThreadStatus(thread))) &&
                (input.settled === undefined ||
                  threadSettlement(thread).settled === input.settled) &&
                (input.snoozed === undefined || isSnoozed(thread, nowMs) === input.snoozed) &&
                (titleContains === undefined ||
                  thread.title.toLocaleLowerCase().includes(titleContains)) &&
                (!onlySubagents || thread.lineage.relationshipToParent === "subagent"),
            );
            return { threads: filtered.slice(cursor, cursor + limit), total: filtered.length };
          }),
        );
  return { ...(yield* page), cursor };
});
