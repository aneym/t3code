import type {
  OrchestrationV2ServerCommand,
  OrchestrationV2AppThread,
  ThreadId,
} from "@t3tools/contracts";
import type { FairRwLockMode } from "@t3tools/shared/FairRwLock";
import type * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { withServerAdmission } from "../serverHandoffBarrier.ts";
import type { EffectOutboxV2Shape } from "./EffectOutbox.ts";
import { OrchestratorDispatchError } from "./OrchestratorDispatchError.ts";
import { isPlainSend } from "./SharedDispatchPolicy.ts";

const SIDE_CHAT_SOURCE_WAIT = "30 seconds";

export function makeCommandDispatchAdmission<A, E, R, P>(options: {
  readonly execute: (
    command: OrchestrationV2ServerCommand,
    sideChatIds?: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<A, E, R>;
  readonly findThread: (threadId: ThreadId) => Effect.Effect<OrchestrationV2AppThread | null, E, R>;
  readonly liveSideChatIds: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<ThreadId>, E, R>;
  readonly commandThreadId: (command: OrchestrationV2ServerCommand) => ThreadId;
  readonly mayStartFollowup: (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>,
  ) => boolean;
  readonly parentThreadId: (threadId: ThreadId) => Effect.Effect<ThreadId | undefined, P>;
  readonly outbox: Pick<EffectOutboxV2Shape, "admit">;
  readonly locks: KeyedLock.KeyedLock<ThreadId>;
}) {
  const execute = (command: OrchestrationV2ServerCommand, sideChatIds?: ReadonlyArray<ThreadId>) =>
    withServerAdmission(options.execute(command, sideChatIds));
  // dispatchWithReceiptEffect owns the dispatch span; this wrapper selects the thread locks.
  const dispatch = Effect.fnUntraced(function* (command: OrchestrationV2ServerCommand) {
    const label = { type: command.type, thread: options.commandThreadId(command) };
    const admitted = (mode: FairRwLockMode, sideChatIds?: ReadonlyArray<ThreadId>) =>
      options.outbox.admit(label, mode, execute(command, sideChatIds));
    const execution = options.locks.withLock(label.thread, admitted("exclusive"));
    const plainSend = isPlainSend(command);
    // A parent's lock comes before its side chats' locks, so a delete cascade and a side chat
    // fork or command never interleave. A fork from a side chat or onto an existing thread would
    // invert that order; dispatch rejects both, so they skip the source lock.
    if (
      command.type === "thread.fork" &&
      command.sideChat === true &&
      command.sourceThreadId !== command.targetThreadId
    ) {
      const source = yield* options.findThread(command.sourceThreadId);
      const target = yield* options.findThread(command.targetThreadId);
      if (source === null || source.lineage.sideChat === true || target !== null)
        return yield* execution;
      const forked = yield* options.locks.withLockWithin(
        command.sourceThreadId,
        SIDE_CHAT_SOURCE_WAIT,
        execution,
      );
      if (Option.isSome(forked)) return forked.value;
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause:
          "The source thread stayed busy for 30 seconds, so the fork did not start. Try again.",
      });
    }
    if (command.type === "thread.delete")
      return yield* options.locks.withLock(
        command.threadId,
        options
          .liveSideChatIds(command.threadId)
          .pipe(
            Effect.flatMap((sideChatIds) =>
              sideChatIds.reduce(
                (locked, sideChatId) => options.locks.withLock(sideChatId, locked),
                admitted("exclusive", sideChatIds),
              ),
            ),
          ),
      );
    if (plainSend && !options.mayStartFollowup(command))
      return yield* options.locks.withLock(label.thread, admitted("shared"));
    // Answering a message-mode question can also start a follow-up.
    if (
      command.type !== "runtime-request.respond" &&
      (command.type !== "message.dispatch" || !options.mayStartFollowup(command))
    )
      return yield* execution;
    const parentThreadId = yield* options.parentThreadId(command.threadId);
    if (plainSend && parentThreadId === undefined)
      return yield* options.locks.withLock(label.thread, admitted("shared"));
    // Follow-up intake and Stop serialize on the parent before taking the child lock.
    return yield* parentThreadId === undefined
      ? execution
      : options.locks.withLock(parentThreadId, execution);
  });
  return { execute, dispatch };
}
