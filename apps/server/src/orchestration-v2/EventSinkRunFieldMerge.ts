import type { OrchestrationV2DomainEvent, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

// The enclosing write or commit span already traces this per-event projection merge.
export const mergeRunField = Effect.fnUntraced(function* (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  field: "delegatedCompletion" | "restartDeclined",
  includesRun: (runId: RunId) => boolean = () => true,
) {
  return yield* Effect.forEach(events, (event) =>
    Effect.gen(function* () {
      if (event.type !== "run.updated" || !includesRun(event.payload.id)) return event;
      const { runs } = yield* projectionStore.getThreadRecords(event.threadId, ["runs"], {
        runIds: [event.payload.id],
      });
      const current = runs[0];
      return current === undefined
        ? event
        : { ...event, payload: { ...current, [field]: event.payload[field] } };
    }),
  );
});
