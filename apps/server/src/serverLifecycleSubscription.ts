import type { ServerLifecycleStreamEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";
import { registerHandoffClient } from "./serverHandoffDelivery.ts";
export const subscribeServerLifecycle = (
  lifecycleEvents: ServerLifecycleEvents["Service"],
  input: { readonly handoffClientId?: string },
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      yield* registerHandoffClient(input.handoffClientId);
      const liveBuffer = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
      yield* Effect.forkScoped(
        lifecycleEvents.stream.pipe(Stream.runForEach((event) => Queue.offer(liveBuffer, event))),
        { startImmediately: true },
      );
      const snapshot = yield* lifecycleEvents.snapshot;
      const snapshotEvents = Array.from(snapshot.events).toSorted(
        (left, right) => left.sequence - right.sequence,
      );
      const liveEvents = Stream.fromQueue(liveBuffer).pipe(
        Stream.filter((event) => event.sequence > snapshot.sequence),
      );
      return Stream.concat(Stream.fromArray(snapshotEvents), liveEvents);
    }),
  );
