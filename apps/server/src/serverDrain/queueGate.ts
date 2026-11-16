import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ServerDrain } from "./ServerDrain.ts";

export const layerQueueGate = Layer.effect(
  ProjectionStoreV2,
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    const drain = yield* ServerDrain;
    return ProjectionStoreV2.of({
      ...store,
      canStartQueuedRun: Effect.fn("ServerDrain.gateQueuedRunStart")(function* (threadId) {
        if (yield* drain.draining) return false;
        return yield* store.canStartQueuedRun(threadId);
      }),
    });
  }),
);
