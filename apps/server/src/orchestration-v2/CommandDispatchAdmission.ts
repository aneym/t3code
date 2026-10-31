import type { OrchestrationV2ServerCommand, ThreadId } from "@t3tools/contracts";
import type * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Effect from "effect/Effect";
import { withServerAdmission } from "../serverHandoffBarrier.ts";
import type { EffectOutboxV2Shape } from "./EffectOutbox.ts";

export function makeCommandDispatchAdmission<A, E, R, P>(options: {
  readonly execute: (command: OrchestrationV2ServerCommand) => Effect.Effect<A, E, R>;
  readonly commandThreadId: (command: OrchestrationV2ServerCommand) => ThreadId;
  readonly mayStartFollowup: (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>,
  ) => boolean;
  readonly parentThreadId: (threadId: ThreadId) => Effect.Effect<ThreadId | undefined, P>;
  readonly outbox: Pick<EffectOutboxV2Shape, "withDispatch">;
  readonly locks: KeyedLock.KeyedLock<ThreadId>;
}) {
  const execute = (command: OrchestrationV2ServerCommand) =>
    withServerAdmission(options.execute(command));
  // dispatchWithReceiptEffect owns the dispatch span; this wrapper selects the thread locks.
  const dispatch = Effect.fnUntraced(function* (command: OrchestrationV2ServerCommand) {
    const execution = options.locks.withLock(
      options.commandThreadId(command),
      options.outbox.withDispatch(execute(command)),
    );
    // Answering a message-mode question can also start a follow-up.
    if (
      command.type !== "runtime-request.respond" &&
      (command.type !== "message.dispatch" || !options.mayStartFollowup(command))
    )
      return yield* execution;
    const parentThreadId = yield* options.parentThreadId(command.threadId);
    // Follow-up intake and Stop serialize on the parent before taking the child lock.
    return yield* parentThreadId === undefined
      ? execution
      : options.locks.withLock(parentThreadId, execution);
  });
  return { execute, dispatch };
}
