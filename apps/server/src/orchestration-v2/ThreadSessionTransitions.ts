import {
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  THREAD_SESSION_RESTART_REASON,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as ThreadSessionRestarts from "./ThreadSessionRestarts.ts";

export const makeThreadSelectionPlanner = Effect.gen(function* () {
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const switches = yield* ProviderSwitchService.ProviderSwitchServiceV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  return Effect.fn("ThreadSessionTransitions.planSelectionChange")(function* (input: {
    readonly projection: ProjectionStore.ProjectionThreadProviderContext;
    readonly targetModelSelection: ModelSelection;
  }) {
    yield* adapters.get(input.targetModelSelection.instanceId);
    const plan = yield* switches.plan(input);
    if (plan.releaseProviderSessionIds.length === 0) return plan;
    const { runs } = yield* store.getThreadRecords(input.projection.thread.id, ["runs"]);
    return runs.some((run) => ["preparing", "starting", "running", "waiting"].includes(run.status))
      ? { ...plan, releaseProviderSessionIds: [] }
      : plan;
  });
});

export const makeThreadSessionPreparation = Effect.gen(function* () {
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  return Effect.fn("ThreadSessionTransitions.prepareSession")(function* (input: {
    readonly projection: Pick<OrchestrationV2ThreadProjection, "thread" | "providerSessions">;
    readonly run: OrchestrationV2Run;
    readonly providerThread: OrchestrationV2ProviderThread;
  }) {
    const { projection, run, providerThread } = input;
    for (const session of projection.providerSessions) {
      if (
        session.providerInstanceId !== run.providerInstanceId &&
        session.status !== "stopped" &&
        session.status !== "error"
      ) {
        yield* sessions.detach({
          providerSessionId: session.id,
          threadId: projection.thread.id,
          detail: "Provider or model selection changed.",
        });
      }
    }
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
