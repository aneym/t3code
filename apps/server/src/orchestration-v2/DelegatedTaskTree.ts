import {
  CommandId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { releasesStopHoldOf } from "./QueueHoldPolicy.ts";

interface TreeInput {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
}

export interface DelegatedTaskTreeDeps<E> {
  readonly subagents: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2Subagent>, E>;
  readonly runs: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<OrchestrationV2Run>, E>;
  readonly dispatch: (command: OrchestrationV2ServerCommand) => Effect.Effect<unknown, E>;
}

const collect = <E>(failures: Array<E>, context: Record<string, unknown>) =>
  Effect.catch((error: E) =>
    Effect.logWarning("Unable to reach a delegated task", { ...context, error }).pipe(
      Effect.andThen(Effect.sync(() => failures.push(error))),
    ),
  );

export const stopDelegatedTaskTree: <E>(
  deps: DelegatedTaskTreeDeps<E>,
  input: TreeInput & {
    readonly reason?: string | undefined;
    readonly heldByThreadId?: ThreadId | undefined;
  },
) => Effect.Effect<void, E> = Effect.fn("DelegatedTaskTree.stop")(function* <E>(
  deps: DelegatedTaskTreeDeps<E>,
  input: TreeInput & {
    readonly reason?: string | undefined;
    readonly heldByThreadId?: ThreadId | undefined;
  },
) {
  const heldByThreadId = input.heldByThreadId ?? input.threadId;
  const failures: Array<E> = [];
  const stoppedChildThreadIds = new Set<ThreadId>();
  for (const task of yield* deps.subagents(input.threadId)) {
    if (task.origin !== "app_owned") continue;
    if (task.childThreadId === null) {
      if (task.remoteChild === undefined) continue;
      const commandId = CommandId.make(`${input.commandId}:stop:${task.id}`);
      yield* deps
        .dispatch(
          task.result === null
            ? {
                type: "delegated_task.remote.complete",
                commandId,
                parentThreadId: input.threadId,
                taskId: task.id,
                status: "interrupted",
                result:
                  input.reason === undefined
                    ? "Stopped with its parent."
                    : `Stopped with its parent: ${input.reason}`,
              }
            : {
                type: "delegated_task.remote.stop",
                commandId,
                parentThreadId: input.threadId,
                taskId: task.id,
              },
        )
        .pipe(collect(failures, { parentThreadId: input.threadId, taskId: task.id }));
      continue;
    }
    const threadId = task.childThreadId;
    if (stoppedChildThreadIds.has(threadId)) continue;
    stoppedChildThreadIds.add(threadId);
    yield* deps
      .dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`${input.commandId}:stop:${threadId}`),
        threadId,
        stopDelegatedTasks: false,
        heldByThreadId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
      .pipe(
        Effect.andThen(stopDelegatedTaskTree(deps, { ...input, threadId, heldByThreadId })),
        collect(failures, { parentThreadId: input.threadId, threadId }),
      );
  }
  if (failures[0] !== undefined) return yield* Effect.fail(failures[0]);
});

export const resumeDelegatedTaskTree: <E>(
  deps: DelegatedTaskTreeDeps<E>,
  input: TreeInput & { readonly heldByThreadId?: ThreadId | undefined },
) => Effect.Effect<void, E> = Effect.fn("DelegatedTaskTree.resume")(function* <E>(
  deps: DelegatedTaskTreeDeps<E>,
  input: TreeInput & { readonly heldByThreadId?: ThreadId | undefined },
) {
  const heldByThreadId = input.heldByThreadId ?? input.threadId;
  const releases = releasesStopHoldOf(heldByThreadId);
  const failures: Array<E> = [];
  const visited = new Set<ThreadId>();
  for (const task of yield* deps.subagents(input.threadId)) {
    const threadId = task.childThreadId;
    if (task.origin !== "app_owned" || threadId === null || visited.has(threadId)) continue;
    visited.add(threadId);
    yield* Effect.gen(function* () {
      const runs = yield* deps.runs(threadId);
      if (runs.some((run) => run.status === "queued" && releases(run))) {
        yield* deps.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`${input.commandId}:resume:${threadId}`),
          threadId,
          heldByThreadId,
        });
      }
      yield* resumeDelegatedTaskTree(deps, { ...input, threadId, heldByThreadId });
    }).pipe(collect(failures, { parentThreadId: input.threadId, threadId }));
  }
  if (failures[0] !== undefined) return yield* Effect.fail(failures[0]);
});
