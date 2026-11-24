import type { OrchestrationProjectShell, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteLanes from "@t3tools/shared/nodeSqliteLanes";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { subagentClosure } from "../chatSession/ChatSessionDescendants.ts";
import { loadSubscriberShellSnapshot } from "./ShellStream.ts";
import type * as ThreadManagementService from "./ThreadManagementService.ts";

export class ShellThreadRoots extends Context.Reference<ReadonlySet<ThreadId> | undefined>(
  "t3/orchestration-v2/ActiveSubscriberShell/ShellThreadRoots",
  { defaultValue: () => undefined },
) {}

export const loadActiveSubscriberShell = Effect.fn("ActiveSubscriberShell.load")(function* <
  E1,
  E2,
>(input: {
  readonly sql: SqlClient.SqlClient;
  readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"];
  readonly listProjects: Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, E1>;
  readonly latestSequence: Effect.Effect<number, E2>;
  readonly options: { readonly omitIdleSubagents: boolean; readonly omitOlderSettled: boolean };
}) {
  const { threadManagement } = input;
  const roots = yield* ShellThreadRoots;
  const subagentIds = new Set<string>();
  const read = (threadIds: ReadonlyArray<ThreadId> | undefined) =>
    threadManagement.readShellSnapshot({
      location: "active",
      ...(threadIds === undefined ? {} : { threadIds }),
    });
  const loaded = yield* loadSubscriberShellSnapshot({
    sql: input.sql,
    listShellIndex: threadManagement.listActiveShellIndex(),
    readThreads:
      roots === undefined
        ? read
        : (threadIds) =>
            threadManagement.listActiveShellIndex({ liveness: false }).pipe(
              Effect.flatMap((index) => {
                const scope = subagentClosure(new Map([...roots].map((id) => [id, 0])), index);
                for (const entry of index) {
                  if (entry.lineage.relationshipToParent === "subagent") subagentIds.add(entry.id);
                }
                return read((threadIds ?? [...scope.keys()]).filter((id) => scope.has(id)));
              }),
            ),
    listProjects: input.listProjects,
    latestSequence: input.latestSequence,
    options: input.options,
  }).pipe(NodeSqliteLanes.interactive);
  for (const id of loaded.subagentThreadIds) subagentIds.add(id);
  return { snapshot: loaded.snapshot, subagentThreadIds: subagentIds };
});
