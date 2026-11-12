import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ServerSettings from "../serverSettings.ts";
import { isAutoSettlementCandidate } from "./AutoSettlementPolicy.ts";
import { OrchestratorDispatchError } from "./OrchestratorDispatchError.ts";
import { OrchestratorProjectionError } from "./OrchestratorErrors.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

type AutoSettleCommand = Extract<OrchestrationV2ServerCommand, { type: "thread.auto-settle" }>;

export const makeAutoSettlementValidation = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  return Effect.fn("Orchestrator.validateAutoSettlement")(function* (command: AutoSettleCommand) {
    const check = Effect.gen(function* () {
      if (command.settledParentThreadId === undefined) {
        const thread = yield* projections.getThread(command.threadId);
        return (
          thread.settledOverride === null &&
          DateTime.toEpochMillis(thread.updatedAt) <= DateTime.toEpochMillis(command.snapshotAt)
        );
      }
      const thread = yield* projections.getThreadShell(command.threadId);
      if (thread === null || thread.snoozedUntil != null) return false;
      if (DateTime.toEpochMillis(thread.updatedAt) > DateTime.toEpochMillis(command.snapshotAt)) {
        return false;
      }
      if (!(yield* settings.getSettings).settleIdleChildren) return false;
      if (!isAutoSettlementCandidate(thread, DateTime.toEpochMillis(yield* DateTime.now)))
        return false;
      if (
        thread.lineage.relationshipToParent !== "subagent" ||
        thread.lineage.parentThreadId !== command.settledParentThreadId ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        thread.settledOverride === "settled"
      )
        return false;
      const parent = yield* projections.getThreadShell(command.settledParentThreadId);
      if (parent === null || parent.deletedAt !== null || parent.settledOverride !== "settled")
        return false;
      const records = yield* projections.getThreadRecords(command.threadId, [
        "runs",
        "runtimeRequests",
        "providerThreads",
        "turnItems",
      ]);
      if (
        records.runs.some((run) =>
          ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
        )
      )
        return false;
      if (records.runtimeRequests.some((request) => request.status === "pending")) return false;
      if (
        records.turnItems.some((item) => item.type === "link_request" && item.status === "waiting")
      )
        return false;
      return !backgroundWorkHoldsCompletion(
        derivePendingBackgroundWork({
          latestRun: records.runs.findLast((run) => run.status !== "queued"),
          runs: records.runs,
          providerThreads: records.providerThreads,
          turnItems: records.turnItems,
          activeProviderThreadId: thread.activeProviderThreadId,
          pullRequests: thread.pullRequests,
        }),
      );
    }).pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
      ),
    );
    if (!(yield* check)) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} changed before automatic settlement.`,
      });
    }
  });
});
