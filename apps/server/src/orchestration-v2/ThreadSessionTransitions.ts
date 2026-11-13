import {
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  THREAD_SESSION_RESTART_REASON,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadSessionRestarts from "./ThreadSessionRestarts.ts";

export const makeThreadSessionPreparation = Effect.gen(function* () {
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  return Effect.fn("ThreadSessionTransitions.prepareSession")(function* (input: {
    readonly projection: Pick<OrchestrationV2ThreadProjection, "thread">;
    readonly providerThread: OrchestrationV2ProviderThread;
  }) {
    const { projection, providerThread } = input;
    if (!ThreadSessionRestarts.threadSessionRestartRequested(projection.thread.id)) return;
    const hasPendingBackgroundTasks = yield* store
      .getThreadRecords(projection.thread.id, ["providerThreads"])
      .pipe(
        Effect.map(
          (records) =>
            (records.providerThreads.find((candidate) => candidate.id === providerThread.id)
              ?.pendingBackgroundTasks?.length ?? 0) > 0,
        ),
        Effect.orElseSucceed(() => true),
      );
    if (
      !hasPendingBackgroundTasks &&
      ThreadSessionRestarts.takeThreadSessionRestart(projection.thread.id) &&
      providerThread.providerSessionId !== null
    ) {
      yield* sessions
        .detach({
          providerSessionId: providerThread.providerSessionId,
          threadId: projection.thread.id,
          detail: THREAD_SESSION_RESTART_REASON,
        })
        .pipe(Effect.ignoreCause({ log: true }));
    }
  });
});
