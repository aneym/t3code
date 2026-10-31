import {
  CommandId,
  pendingGuestMessageCount,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ServerSettings from "../serverSettings.ts";
import { OrchestratorDispatchError } from "./OrchestratorDispatchError.ts";
import type { OrchestratorV2 } from "./Orchestrator.ts";
import { OrchestratorProjectionError } from "./OrchestratorErrors.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

type AutoSettleCommand = Extract<OrchestrationV2ServerCommand, { type: "thread.auto-settle" }>;

export const makeAutoSettlementValidation = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  return Effect.fn("Orchestrator.validateAutoSettlement")(function* (command: AutoSettleCommand) {
    const check = Effect.gen(function* () {
      const thread = yield* projections.getThread(command.threadId);
      if (DateTime.toEpochMillis(thread.updatedAt) > DateTime.toEpochMillis(command.snapshotAt)) {
        return false;
      }
      if (command.settledParentThreadId === undefined) return thread.settledOverride === null;
      if (!(yield* settings.getSettings).settleIdleChildren) return false;
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
      if (pendingGuestMessageCount(thread.guestShare) > 0) return false;
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

export const makeChildSettlementSweep = Effect.fn(
  "ThreadSettlementServiceV2.makeChildSettlementSweep",
)(function* (dispatch: OrchestratorV2["Service"]["dispatch"]) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  return Effect.fn("ThreadSettlementServiceV2.settleIdleChildren")(
    function* (threadId: ThreadId | undefined, parentId?: ThreadId) {
      if (!(yield* settings.getSettings).settleIdleChildren) return;
      const threadIds =
        threadId === undefined
          ? yield* projections.listActiveSubagentThreadIds({
              ...(parentId === undefined ? {} : { parentId }),
              unsettledOnly: true,
            })
          : [threadId];
      const parents = new Map<ThreadId, OrchestrationV2ThreadShell | null>();
      for (const id of threadIds) {
        const thread = yield* projections.getThread(id);
        const parentId = thread.lineage.parentThreadId;
        if (
          thread.lineage.relationshipToParent !== "subagent" ||
          parentId === null ||
          thread.settledOverride === "settled"
        )
          continue;
        if (!parents.has(parentId))
          parents.set(parentId, yield* projections.getThreadShell(parentId));
        const parent = parents.get(parentId);
        if (parent == null || parent.settledOverride !== "settled" || parent.deletedAt !== null)
          continue;
        const current = yield* projections.getThreadShell(thread.id);
        if (
          current === null ||
          current.archivedAt !== null ||
          current.pendingRuntimeRequest !== null ||
          current.activityRunStatus !== null ||
          ["queued", "preparing", "starting", "running", "waiting"].includes(current.status) ||
          backgroundWorkHoldsCompletion(current.pendingBackgroundTasks ?? [])
        )
          continue;
        const uuid = yield* crypto.randomUUIDv4();
        yield* dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make(`server:child-settle:${thread.id}:${uuid}`),
          threadId: thread.id,
          settledParentThreadId: parentId,
          snapshotAt: current.updatedAt,
        }).pipe(Effect.catchTags({ OrchestratorDispatchError: () => Effect.void }));
      }
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("idle child settlement sweep failed", { cause }),
        ),
      ),
  );
});
