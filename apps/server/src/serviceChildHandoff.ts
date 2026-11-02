import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import { freezeServiceChild } from "./serviceChildFreeze.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Launcher handoff is a process lifecycle boundary.
import { reopenServerAdmissions } from "./serverHandoffBarrier.ts";
import * as Queue from "effect/Queue";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { decodeServiceLauncherParentMessage } from "./cloud/serviceProtocol.ts";
import { hotSwapContext, sendServiceMessage } from "./serviceChildTransport.ts";

export const runServiceHandoff = Effect.fn("serviceChildHandoff.run")(function* () {
  if (hotSwapContext() === undefined) return;
  const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
  const analytics = yield* AnalyticsService.AnalyticsService;
  const messages = yield* Queue.unbounded<unknown>();
  let draining: { updateId: string; abort: Queue.Queue<void> } | undefined;
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const receive = (value: unknown) => {
        const message = decodeServiceLauncherParentMessage(value);
        if (message?.type === "abort-drain" && message.updateId === draining?.updateId)
          Queue.offerUnsafe(draining.abort, undefined);
        Queue.offerUnsafe(messages, value);
      };
      process.on("message", receive);
      return receive;
    }),
    (receive) =>
      Effect.sync(() => {
        process.off("message", receive);
      }),
  );
  yield* Stream.fromQueue(messages).pipe(
    Stream.runForEach((value) => {
      const message = decodeServiceLauncherParentMessage(value);
      if (message?.type === "drain")
        return Effect.gen(function* () {
          const abort = yield* Queue.sliding<void>(1);
          draining = { updateId: message.updateId, abort };
          yield* Effect.all(
            [
              recovery.drainForHandoff(message.updateId, message.drainTimeoutMs),
              analytics.flush.pipe(Effect.timeoutOption(message.drainTimeoutMs), Effect.ignore),
            ],
            { concurrency: 2, discard: true },
          ).pipe(
            Effect.as(true),
            Effect.raceFirst(Queue.take(abort).pipe(Effect.as(false))),
            Effect.flatMap((drained) =>
              drained
                ? sendServiceMessage({ type: "drained", updateId: message.updateId })
                : Effect.void,
            ),
            Effect.catchCause(() =>
              sendServiceMessage({ type: "drain-failed", updateId: message.updateId }).pipe(
                Effect.ignore,
              ),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                draining = undefined;
              }),
            ),
          );
        });
      if (message?.type === "abort-drain")
        return recovery
          .abortRestart(message.updateId)
          .pipe(Effect.ignore, Effect.andThen(Effect.sync(reopenServerAdmissions)));
      if (message?.type === "relinquish") return freezeServiceChild(message.updateId);
      return Effect.void;
    }),
    Effect.forkScoped,
  );
});
