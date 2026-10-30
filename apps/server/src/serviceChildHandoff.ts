import { awaitHandoffReceipts } from "./serverHandoffDelivery.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Launcher handoff is a process lifecycle boundary.
import { freezeServerAdmissions, reopenServerAdmissions } from "./serverHandoffBarrier.ts";
import * as Queue from "effect/Queue";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { decodeServiceLauncherParentMessage } from "./cloud/serviceProtocol.ts";
import {
  freezeServiceConnections,
  hotSwapContext,
  sendServiceMessage,
} from "./serviceChildTransport.ts";

export const runServiceHandoff = Effect.fn("serviceChildHandoff.run")(function* () {
  if (hotSwapContext() === undefined) return;
  const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
  const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
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
      if (message?.type === "relinquish")
        return freezeServerAdmissions().pipe(
          Effect.timeout(Math.max(1, (hotSwapContext()?.hotSwap?.holdBudgetMs ?? 1) / 2)),
          Effect.andThen(recovery.prepareRestart(message.updateId, 0)),
          Effect.andThen(
            lifecycle.publish({
              version: 1,
              type: "handoff",
              payload: { reconnectWithinMs: hotSwapContext()?.hotSwap?.holdBudgetMs ?? 0 },
            }),
          ),
          Effect.tap((event) =>
            awaitHandoffReceipts(event.sequence, hotSwapContext()?.hotSwap?.holdBudgetMs ?? 0),
          ),
          Effect.andThen(sendServiceMessage({ type: "drained", updateId: message.updateId })),
          Effect.andThen(Effect.sync(relinquishServiceChild)),
          Effect.catchCause(() =>
            sendServiceMessage({ type: "drain-failed", updateId: message.updateId }).pipe(
              Effect.ignore,
            ),
          ),
        );
      return Effect.void;
    }),
    Effect.forkScoped,
  );
});

function relinquishServiceChild(): void {
  freezeServiceConnections();
  process.kill(process.pid, "SIGTERM");
}
