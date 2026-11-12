import {
  isListedThreadLineage,
  type OrchestrationV2AppThreadLineage,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as Orchestrator from "./Orchestrator.ts";

export interface ProjectThreadListInput {
  readonly projectId?: ProjectId | undefined;
  readonly includeSubagents: boolean;
}

export interface ProjectThreadPageInput extends ProjectThreadListInput {
  readonly onlySubagents: boolean;
  readonly cursor: number;
  readonly limit: number;
}

export interface ProjectThreadPage {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly total: number;
}

interface Listed {
  readonly id: ThreadId;
  readonly updatedAt: DateTime.Utc;
  readonly lineage: OrchestrationV2AppThreadLineage;
}

const isListed = (input: ProjectThreadListInput, thread: Listed) =>
  input.includeSubagents ? thread.lineage.sideChat !== true : isListedThreadLineage(thread.lineage);

const newestFirst = (left: Listed, right: Listed) =>
  DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
  right.id.localeCompare(left.id);

export const makeProjectThreadListing = (
  orchestrator: Pick<
    Orchestrator.OrchestratorV2["Service"],
    "getShellSnapshot" | "listActiveShellIndex"
  >,
) => ({
  listProjectThreads: (input: ProjectThreadListInput) =>
    orchestrator
      .getShellSnapshot({
        location: "active",
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      })
      .pipe(
        Effect.map((snapshot) =>
          snapshot.threads.filter((thread) => isListed(input, thread)).toSorted(newestFirst),
        ),
      ),
  listProjectThreadPage: Effect.fn("ThreadManagementService.listProjectThreadPage")(function* (
    input: ProjectThreadPageInput,
  ) {
    const matching = (yield* orchestrator.listActiveShellIndex({ liveness: false }))
      .filter(
        (entry) =>
          (input.projectId === undefined || entry.projectId === input.projectId) &&
          isListed(input, entry) &&
          (!input.onlySubagents || entry.lineage.relationshipToParent === "subagent"),
      )
      .toSorted(newestFirst);
    const ids = matching.slice(input.cursor, input.cursor + input.limit).map((entry) => entry.id);
    const shells =
      ids.length === 0
        ? []
        : (yield* orchestrator.getShellSnapshot({ location: "active", threadIds: ids })).threads;
    const byId = new Map(shells.map((shell) => [shell.id, shell]));
    return { threads: ids.flatMap((id) => byId.get(id) ?? []), total: matching.length };
  }),
});
