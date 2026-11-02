// @effect-diagnostics nodeBuiltinImport:off -- Relinquishing ownership exits the native service child.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import { awaitHandoffReceipts } from "./serverHandoffDelivery.ts";
import {
  admittedRequestCount,
  freezeServerAdmissions,
  reopenServerAdmissions,
} from "./serverHandoffBarrier.ts";
import * as EffectOutbox from "./orchestration-v2/EffectOutbox.ts";
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
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const clock = yield* Clock.Clock;
  const now = () => Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n);
  const budget = hotSwapContext()?.hotSwap?.holdBudgetMs ?? 1;
  const holdDeadline = now() + budget;
  const preparationDeadline = holdDeadline - budget / 2;
  let mayRelinquish = true;
  const preparation = yield* freezeServerAdmissions().pipe(
    Effect.andThen(recovery.prepareRestart(updateId, 0)),
    Effect.andThen(
      lifecycle.publish({ version: 1, type: "handoff", payload: { reconnectWithinMs: budget } }),
    ),
    Effect.tap((event) => awaitHandoffReceipts(event.sequence, budget)),
    Effect.andThen(sendServiceMessage({ type: "drained", updateId })),
    Effect.andThen(
      Effect.sync(() => {
        if (!mayRelinquish || now() >= preparationDeadline) return false;
        relinquish();
        return true;
      }),
    ),
    Effect.catchCause(() => Effect.succeed(false)),
    Effect.forkDetach,
  );
  const frozen = yield* Fiber.join(preparation).pipe(
    Effect.timeoutOption(Math.max(1, preparationDeadline - now())),
  );
  if (Option.isSome(frozen) && frozen.value) return;
  const reason =
    Option.isNone(frozen) || now() >= preparationDeadline
      ? ("freeze-timeout" as const)
      : ("freeze-failed" as const);
  const admittedRequests = yield* Effect.sync(() => {
    mayRelinquish = false;
    const count = admittedRequestCount();
    reopenServerAdmissions();
    return count;
  });
  const snapshot = yield* outbox.runningEffects.pipe(
    Effect.map((effects) =>
      effects.map(({ id, request, threadId, updatedAt }) => ({
        id,
        type: request.type,
        threadId,
        updatedAt,
      })),
    ),
    Effect.catchCause(() => Effect.succeed({ error: "read-failed" })),
    Effect.forkDetach,
  );
  yield* sendServiceMessage({ type: "freeze-aborted", updateId, reason }).pipe(
    Effect.timeoutOption(Math.max(1, holdDeadline - now())),
    Effect.ignore,
  );
  yield* Fiber.join(snapshot).pipe(
    Effect.timeoutOption(Math.max(0, Math.min(1000, (holdDeadline - now()) / 10))),
    Effect.tap((runningEffects) =>
      Option.isNone(runningEffects)
        ? Fiber.interrupt(snapshot).pipe(Effect.forkDetach)
        : Effect.void,
    ),
    Effect.flatMap((runningEffects) =>
      Effect.logWarning("Service handoff aborted before ownership release", {
        updateId,
        reason,
        admittedRequests,
        runningEffects: Option.getOrElse(runningEffects, () => ({ error: "snapshot-timeout" })),
      }),
    ),
    Effect.forkDetach,
  );
  const cleanup = yield* Fiber.interrupt(preparation).pipe(
    Effect.andThen(recovery.abortRestart(updateId)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Service restart abort cleanup failed", { updateId, cause }),
    ),
    Effect.forkDetach,
  );
  yield* Fiber.join(cleanup).pipe(
    Effect.timeoutOption(Math.max(1, holdDeadline - now())),
    Effect.flatMap((result) =>
      Option.isNone(result)
        ? Effect.logWarning("Service restart abort cleanup exceeded HOLD deadline", {
            updateId,
            budget,
          }).pipe(Effect.andThen(Fiber.interrupt(cleanup).pipe(Effect.forkDetach)))
        : Effect.void,
    ),
    Effect.forkDetach,
  );
});

function relinquish(): void {
  freezeServiceConnections();
  process.kill(process.pid, "SIGTERM");
}
