import { latestProviderTurnForAttempt, type OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

type DelegatedTaskRequest = Extract<
  OrchestrationV2Command,
  { readonly type: "delegated_task.request" }
>;

export const readDelegatedTaskParent = Effect.fn("Orchestrator.readDelegatedTaskParent")(function* (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  command: DelegatedTaskRequest,
) {
  const threadId = command.parentThreadId;
  const { thread, runs, nodes } = yield* projectionStore.getThreadRecords(
    threadId,
    ["runs", "nodes"],
    { runIds: [command.parentRunId], nodeIds: [command.parentNodeId] },
  );
  const run = runs[0];
  const attemptId = run?.activeAttemptId ?? null;
  const { providerThreads, providerTurns } = yield* projectionStore.getThreadRecords(
    threadId,
    ["providerThreads", "providerTurns"],
    {
      providerThreadIds: run?.providerThreadId == null ? [] : [run.providerThreadId],
      providerTurnAttemptIds: attemptId === null ? [] : [attemptId],
    },
  );
  const narrow = { thread, runs, nodes, providerThreads, providerTurns, attempts: [] };
  if (attemptId === null || latestProviderTurnForAttempt(providerTurns, attemptId) !== undefined)
    return narrow;
  return {
    ...narrow,
    ...(yield* projectionStore.getThreadRecords(threadId, ["providerTurns", "attempts"])),
  };
});
