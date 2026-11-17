import type { RunId, ThreadId } from "@t3tools/contracts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as EffectOutbox from "./EffectOutbox.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";

export const restartContinuationEffectId = (runId: RunId) => `effect:restart-continuation:${runId}`;

export const restartContinuationEffectPending = (
  outbox: Pick<EffectOutbox.EffectOutboxV2Shape, "get">,
  runId: RunId,
) =>
  outbox
    .get(restartContinuationEffectId(runId))
    .pipe(
      Effect.map(
        Option.exists((effect) => effect.status === "pending" || effect.status === "running"),
      ),
    );

export const latestRunAwaitsRestartContinuation = Effect.fn(
  "RestartContinuationEffect.latestRunAwaitsRestartContinuation",
)(function* (
  projections: Pick<ProjectionStore.ProjectionStoreV2Shape, "getThreadRecords">,
  outbox: Pick<EffectOutbox.EffectOutboxV2Shape, "get">,
  threadId: ThreadId,
  heldRunIds: ReadonlySet<RunId>,
) {
  const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
  const source = latestExecutedRun(runs.filter((run) => !heldRunIds.has(run.id)));
  return source !== null && (yield* restartContinuationEffectPending(outbox, source.id));
});
