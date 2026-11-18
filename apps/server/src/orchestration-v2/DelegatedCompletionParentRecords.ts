import type { OrchestrationV2Subagent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

export const readCompletionParent = Effect.fn("Orchestrator.readCompletionParent")(function* (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  threadId: ThreadId,
  task: OrchestrationV2Subagent,
) {
  const owner = yield* projectionStore.getThreadRecords(
    threadId,
    ["runs", "nodes", "turnItems", "contextTransfers"],
    {
      runIds: task.runId === null ? [] : [task.runId],
      nodeIds: [task.id],
      turnItemTypes: ["subagent"],
      turnItemRunIds: [task.runId],
    },
  );
  const delivery = owner.runs[0]?.delegatedCompletion?.delivery ?? null;
  const { messages, subagents } = yield* projectionStore.getThreadRecords(
    threadId,
    ["messages", "subagents"],
    {
      messageIds: delivery === null ? [] : [delivery.messageId],
      messageRoles: ["user"],
      omitSettledSubagents: { except: [task.id, ...(delivery?.taskIds ?? [])] },
    },
  );
  const deliveryRunId = messages[0]?.runId ?? null;
  const deliveryRuns =
    deliveryRunId === null || owner.runs.some((run) => run.id === deliveryRunId)
      ? []
      : (yield* projectionStore.getThreadRecords(threadId, ["runs"], { runIds: [deliveryRunId] }))
          .runs;
  return {
    ...owner,
    runs: [...owner.runs, ...deliveryRuns],
    messages,
    subagents,
    providerThreads: [],
    providerTurns: [],
  };
});
