import {
  CommandId,
  ProviderInstanceId,
  type RunId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  THREAD_SESSION_RESTART_REASON,
} from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as ThreadSessionRestarts from "./ThreadSessionRestarts.ts";

export class OrchestratorProviderAdapterError extends Schema.TaggedError<OrchestratorProviderAdapterError>()(
  "OrchestratorProviderAdapterError",
  {
    commandId: CommandId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter failed while dispatching orchestration command ${this.commandId}.`;
  }
}

export const makeThreadSelectionPlanner = Effect.gen(function* () {
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const switches = yield* ProviderSwitchService.ProviderSwitchServiceV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  return Effect.fn("ThreadSessionTransitions.planSelectionChange")(function* (input: {
    readonly commandId: CommandId;
    readonly projection: ProjectionStore.ProjectionThreadProviderContext;
    readonly targetModelSelection: ModelSelection;
    readonly startingRunId?: RunId;
  }) {
    yield* adapters.get(input.targetModelSelection.instanceId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorProviderAdapterError({
            commandId: input.commandId,
            providerInstanceId: input.targetModelSelection.instanceId,
            cause,
          }),
      ),
    );
    const plan = yield* switches.plan(input);
    if (plan.releaseProviderSessionIds.length === 0) return plan;
    const { runs, providerThreads, nodes, turnItems } = yield* store.getThreadRecords(
      input.projection.thread.id,
      ["runs", "providerThreads", "nodes", "turnItems"],
    );
    const sessionBusy =
      runs.some(
        (run) =>
          run.id !== input.startingRunId &&
          ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
      ) ||
      providerThreads.some(
        (thread) =>
          (thread.pendingBackgroundTasks?.length ?? 0) > 0 ||
          (thread.ownerNodeId !== null &&
            nodes.some(
              (node) =>
                node.id === thread.ownerNodeId &&
                ["pending", "running", "waiting"].includes(node.status),
            )),
      );
    return sessionBusy ||
      derivePendingBackgroundWork({
        runs,
        hasActiveRun: false,
        providerThreads,
        turnItems,
        latestRun: runs.findLast((run) => run.id !== input.startingRunId),
        activeProviderThreadId: input.projection.thread.activeProviderThreadId,
      }).length > 0
      ? { ...plan, releaseProviderSessionIds: [] }
      : plan;
  });
});

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
