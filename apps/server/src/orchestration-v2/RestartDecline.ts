import type { OrchestrationV2Run, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EventSink from "./EventSink.ts";

export const recordRestartDeclined = Effect.fn("RestartDecline.record")(function* (
  threadId: ThreadId,
  source: OrchestrationV2Run,
  reason: OrchestrationV2Run["restartDeclined"],
) {
  yield* (yield* EventSink.EventSinkV2).writeWithEffects({
    updateRestartDeclinedOnly: true,
    effects: [],
    events: [
      {
        id: yield* (yield* IdAllocator.IdAllocatorV2).allocate.event({ threadId }),
        type: "run.updated",
        threadId,
        runId: source.id,
        providerInstanceId: source.providerInstanceId,
        occurredAt: yield* DateTime.now,
        payload: { ...source, restartDeclined: reason, restartHandoffPending: false },
      },
    ],
  });
});
