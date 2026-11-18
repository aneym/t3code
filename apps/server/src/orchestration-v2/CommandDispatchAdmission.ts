import type {
  OrchestrationV2ServerCommand,
  OrchestrationV2AppThread,
  ThreadId,
} from "@t3tools/contracts";
import type { FairRwLockMode } from "@t3tools/shared/FairRwLock";
import type * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { BusyNote, GateLabel } from "./DispatchGateRecord.ts";
import type { EffectOutboxV2Shape } from "./EffectOutbox.ts";
import { BUSY_RETRY_AFTER_MS, DispatchAdmissionBound } from "./DispatchAdmissionBound.ts";
import { OrchestratorDispatchBusyError } from "./OrchestratorDispatchError.ts";
import { isPlainSend } from "./SharedDispatchPolicy.ts";

interface ThreadLockHolder {
  readonly label: GateLabel;
  readonly since: number;
}

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
  readonly outbox: Pick<EffectOutboxV2Shape, "admit" | "admitWithin" | "noteBusy">;
  readonly locks: KeyedLock.KeyedLock<ThreadId>;
  readonly intake: KeyedLock.KeyedLock<ThreadId>;
}) {
  const execute = options.execute;
  const threadLocks = new Map<ThreadId, { queue: number; holder: ThreadLockHolder | undefined }>();
  // dispatchWithReceiptEffect owns the dispatch span; this wrapper selects the thread locks.
  const route = Effect.fnUntraced(function* (command: OrchestrationV2ServerCommand) {
    const label = { type: command.type, thread: options.commandThreadId(command) };
    const bound = yield* DispatchAdmissionBound;
    const startedAt = yield* Clock.currentTimeMillis;
    const busy = (lock: BusyNote["lock"]) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        options.outbox.noteBusy({ label, since: startedAt, lock }).pipe(
          Effect.andThen(
            Effect.fail(
              new OrchestratorDispatchBusyError({
                commandId: command.commandId,
                commandType: command.type,
                waitedMs: now - startedAt,
                retryAfterMs: BUSY_RETRY_AFTER_MS,
              }),
            ),
          ),
        ),
      );
    const within = <A, E2, R2>(
      lock: () => BusyNote["lock"],
      bounded: (remainingMs: number) => Effect.Effect<Option.Option<A>, E2, R2>,
    ) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        bounded(Math.max(0, startedAt + (bound ?? 0) - now)),
      ).pipe(
        Effect.flatMap(
          Option.match({ onNone: () => busy(lock()), onSome: (value) => Effect.succeed(value) }),
        ),
      );
    const lockThread = <A, E2, R2>(threadId: ThreadId, effect: Effect.Effect<A, E2, R2>) =>
      Effect.suspend(() => {
        const state = threadLocks.get(threadId) ?? { queue: 0, holder: undefined };
        threadLocks.set(threadId, state);
        state.queue += 1;
        let queued = true;
        const leave = () => {
          if (queued) state.queue -= 1;
          queued = false;
        };
        const settle = Effect.sync(() => {
          leave();
          if (state.queue === 0 && state.holder === undefined) threadLocks.delete(threadId);
        });
        const held = Effect.flatMap(Clock.currentTimeMillis, (since) => {
          leave();
          state.holder = { label, since };
          return Effect.ensuring(
            effect,
            Effect.sync(() => {
              state.holder = undefined;
            }),
          );
        });
        return (
          bound === undefined
            ? options.locks.withLock(threadId, held)
            : within(
                () => ({ thread: threadId, queue: state.queue, holder: state.holder }),
                (remainingMs) => options.locks.withLockWithin(threadId, remainingMs, held),
              )
        ).pipe(Effect.ensuring(settle));
      });
    const admitted = (mode: FairRwLockMode, sideChatIds?: ReadonlyArray<ThreadId>) =>
      bound === undefined
        ? options.outbox.admit(label, mode, execute(command, sideChatIds))
        : within(
            () => "gate",
            (remainingMs) =>
              options.outbox.admitWithin(label, mode, remainingMs, execute(command, sideChatIds)),
          );
    const execution = lockThread(label.thread, admitted("exclusive"));
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
      return yield* source === null || source.lineage.sideChat === true || target !== null
        ? execution
        : options.locks.withLock(command.sourceThreadId, execution);
    }
    if (command.type === "thread.delete")
      return yield* lockThread(
        command.threadId,
        options
          .liveSideChatIds(command.threadId)
          .pipe(
            Effect.flatMap((sideChatIds) =>
              sideChatIds.reduce(
                (locked, sideChatId) => lockThread(sideChatId, locked),
                admitted("exclusive", sideChatIds),
              ),
            ),
          ),
      );
    if (plainSend && !options.mayStartFollowup(command))
      return yield* lockThread(label.thread, admitted("shared"));
    // Answering a message-mode question can also start a follow-up.
    if (
      command.type !== "runtime-request.respond" &&
      (command.type !== "message.dispatch" || !options.mayStartFollowup(command))
    )
      return yield* execution;
    const parentThreadId = yield* options.parentThreadId(command.threadId);
    if (plainSend && parentThreadId === undefined)
      return yield* lockThread(label.thread, admitted("shared"));
    // Follow-up intake and Stop serialize on the parent before taking the child lock.
    return yield* parentThreadId === undefined ? execution : lockThread(parentThreadId, execution);
  });
  // Taken before the lineage read, so a message whose read yields keeps its place ahead of later
  // messages to the same thread.
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    command.type === "message.dispatch"
      ? options.intake.withLock(command.threadId, route(command))
      : route(command);
  return { execute, dispatch };
}
