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
  const messages = yield* Queue.unbounded<unknown>();
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const receive = (message: unknown) => Queue.offerUnsafe(messages, message);
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
        return recovery.drainForHandoff(message.updateId, message.drainTimeoutMs).pipe(
          Effect.andThen(sendServiceMessage({ type: "drained", updateId: message.updateId })),
          Effect.catchCause(() =>
            sendServiceMessage({ type: "drain-failed", updateId: message.updateId }).pipe(
              Effect.ignore,
            ),
          ),
        );
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
