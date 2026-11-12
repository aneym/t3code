import {
  CommandId,
  ThreadId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { wakesBlockedQueue } from "./QueueHoldPolicy.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

function recoveredProviderInstances(
  healthyBefore: ReadonlySet<ProviderInstanceId>,
  providers: ReadonlyArray<ServerProvider>,
) {
  const healthy = new Set(
    providers
      .filter((provider) => provider.status === "ready" || provider.status === "warning")
      .map((provider) => provider.instanceId),
  );
  return { healthy, recovered: [...healthy].filter((id) => !healthyBefore.has(id)) };
}

const makeWake = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  return Effect.fn("BlockedQueueWakeWorker.wake")(function* (
    instances: ReadonlyArray<ProviderInstanceId>,
  ) {
    if (instances.length === 0) return;
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs
      WHERE status = 'queued'
        AND json_extract(payload_json, '$.queueHoldReason') = 'blocked'
    `;
    for (const row of rows) {
      const threadId = ThreadId.make(row.thread_id);
      yield* Effect.gen(function* () {
        const projection = yield* projections.getThreadRecords(threadId, ["runs"]);
        const instance = instances.find((id) => wakesBlockedQueue(projection, id));
        if (instance === undefined) return;
        const heldAt = projection.runs.find(
          (run) => run.status === "queued" && run.queueHeldAt !== undefined,
        )?.queueHeldAt;
        const stamp = heldAt === undefined ? "unstamped" : DateTime.formatIso(heldAt);
        yield* Effect.logInfo("orchestration-v2.blocked-queue.wake", {
          threadId,
          providerInstanceId: instance,
          heldAt: stamp,
        });
        yield* threads.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`command:system:queue-wake:${threadId}:${stamp}`),
          threadId,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.blocked-queue.wake-failed", { threadId, cause }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const wake = yield* makeWake;
    const registry = yield* ProviderRegistry.ProviderRegistry;
    let healthy: ReadonlySet<ProviderInstanceId> = new Set();
    yield* forkParked(
      Stream.runForEach(
        Stream.concat(Stream.fromEffect(registry.getProviders), registry.streamChanges),
        (providers) => {
          const next = recoveredProviderInstances(healthy, providers);
          healthy = next.healthy;
          return wake(next.recovered).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.blocked-queue.sweep-failed", { cause }),
            ),
          );
        },
      ),
    );
  }),
);
