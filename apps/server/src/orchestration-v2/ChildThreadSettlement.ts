import {
  CommandId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ServerSettings from "../serverSettings.ts";
import { isAutoSettlementCandidate } from "./AutoSettlementPolicy.ts";
import type { OrchestratorV2Error } from "./OrchestratorErrors.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

type AutoSettleCommand = Extract<OrchestrationV2ServerCommand, { type: "thread.auto-settle" }>;

export const makeChildSettlementSweep = Effect.fn(
  "ThreadSettlementServiceV2.makeChildSettlementSweep",
)(function* (
  dispatch: (command: AutoSettleCommand) => Effect.Effect<unknown, OrchestratorV2Error>,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  return Effect.fn("ThreadSettlementServiceV2.settleIdleChildren")(
    function* (threadId: ThreadId | undefined, parentId?: ThreadId) {
      if (!(yield* settings.getSettings).settleIdleChildren) return;
      const threadIds = yield* projections.listActiveSubagentThreadIds({
        ...(parentId === undefined ? {} : { parentId }),
        ...(threadId === undefined ? {} : { threadId }),
        unsettledOnly: true,
        settledParentOnly: true,
      });
      const parents = new Map<ThreadId, OrchestrationV2ThreadShell | null>();
      for (const id of threadIds) {
        const thread = yield* projections.getThreadShell(id);
        if (
          thread === null ||
          thread.snoozedUntil != null ||
          !isAutoSettlementCandidate(thread, DateTime.toEpochMillis(yield* DateTime.now)) ||
          ["queued", "preparing", "starting", "running", "waiting"].includes(thread.status)
        )
          continue;
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
        const uuid = yield* crypto.randomUUIDv4();
        yield* dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make(`server:child-settle:${thread.id}:${uuid}`),
          threadId: thread.id,
          settledParentThreadId: parentId,
          snapshotAt: thread.updatedAt,
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
