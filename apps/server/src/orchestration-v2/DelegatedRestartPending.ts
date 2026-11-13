import type { NodeId, ThreadId } from "@t3tools/contracts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import { delegatedTaskTerminalStatus } from "./DelegatedTaskStatus.ts";
import * as Effect from "effect/Effect";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import type { EffectOutboxV2 } from "./EffectOutbox.ts";
import { childAwaitsRestartContinuation } from "./RestartAwaits.ts";
import { delegatedTaskResultRun } from "./RestartBackgroundNote.ts";

export const delegatedRestartPending = Effect.fn("DelegatedRestartPending.read")(function* (
  projections: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  outbox: EffectOutboxV2["Service"],
  childThreadId: ThreadId,
  taskId?: NodeId,
) {
  const child = yield* projections.getThreadRecords(
    childThreadId,
    ["runs", "messages", "subagents", "providerThreads", "providerTurns", "attempts"],
    { messageRoles: ["user"] },
  );
  if (taskId !== undefined) {
    const runs = child.runs.filter((run) => run.delegatedTaskId === taskId);
    const run = delegatedTaskResultRun(runs, taskId);
    if (run === undefined || delegatedTaskTerminalStatus(run.status) === null) return true;
    return yield* childAwaitsRestartContinuation(outbox, projections, runs, run);
  }
  const progress = delegatedTaskProgress(child);
  if (progress.state !== "result_available") return true;
  if (progress.resultRun === undefined) return false;
  return yield* childAwaitsRestartContinuation(outbox, projections, child.runs, progress.resultRun);
});
