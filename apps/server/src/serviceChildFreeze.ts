// @effect-diagnostics nodeBuiltinImport:off -- Relinquishing ownership exits the native service child.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { awaitHandoffReceipts } from "./serverHandoffDelivery.ts";
import { freezeServerAdmissions, reopenServerAdmissions } from "./serverHandoffBarrier.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import {
  freezeServiceConnections,
  hotSwapContext,
  sendServiceMessage,
} from "./serviceChildTransport.ts";

export const freezeServiceChild = Effect.fn("serviceChildFreeze.run")(function* (updateId: string) {
  const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
  const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
  const budget = hotSwapContext()?.hotSwap?.holdBudgetMs ?? 1;
  const frozen = yield* freezeServerAdmissions().pipe(
    Effect.andThen(recovery.prepareRestart(updateId, 0)),
    Effect.andThen(
      lifecycle.publish({ version: 1, type: "handoff", payload: { reconnectWithinMs: budget } }),
    ),
    Effect.tap((event) => awaitHandoffReceipts(event.sequence, budget)),
    Effect.andThen(sendServiceMessage({ type: "drained", updateId })),
    Effect.andThen(Effect.sync(relinquish)),
    Effect.as(true),
    Effect.timeoutOption(Math.max(1, budget / 2)),
    Effect.catchCause(() => Effect.succeedSome(false)),
  );
  if (Option.isSome(frozen) && frozen.value) return;
  const reason = Option.isNone(frozen) ? ("freeze-timeout" as const) : ("freeze-failed" as const);
  yield* recovery.abortRestart(updateId).pipe(Effect.ignore);
  yield* Effect.sync(reopenServerAdmissions);
  yield* Effect.logWarning("Service handoff aborted before ownership release", {
    updateId,
    reason,
  });
  yield* sendServiceMessage({ type: "freeze-aborted", updateId, reason });
});

function relinquish(): void {
  freezeServiceConnections();
  process.kill(process.pid, "SIGTERM");
}
