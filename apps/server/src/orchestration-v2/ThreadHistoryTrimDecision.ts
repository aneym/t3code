import type { ThreadHistoryMarkTrimmedCommand } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OrchestratorDispatchError } from "./OrchestratorDispatchError.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

export const decideHistoryMarkTrimmed = Effect.fn("Orchestrator.decideHistoryMarkTrimmed")(
  function* (
    command: typeof ThreadHistoryMarkTrimmedCommand.Type,
    projectionStore: ProjectionStoreV2Shape,
  ) {
    const reject = (cause: unknown) =>
      new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: typeof cause === "string" ? `Thread ${command.threadId} ${cause}` : cause,
      });
    const { thread, runs, runtimeRequests } = yield* projectionStore
      .getThreadRecords(command.threadId, ["runs", "runtimeRequests"], { turnItemTypes: [] })
      .pipe(Effect.mapError(reject));
    if (thread.deletedAt !== null) return yield* reject("is deleted.");
    if (
      thread.archivedAt === null ||
      DateTime.toEpochMillis(thread.archivedAt) !== DateTime.toEpochMillis(command.archivedAt)
    )
      return yield* reject("is no longer archived as planned.");
    if (
      runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status)) ||
      runtimeRequests.some((request) => request.status === "pending")
    )
      return yield* reject("has work in progress.");
    return {
      type: "thread.metadata-updated" as const,
      threadId: thread.id,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: command.trimmedAt,
      payload: { ...thread, historyTrimmedAt: command.trimmedAt },
    };
  },
);
