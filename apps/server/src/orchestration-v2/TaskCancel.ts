import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TaskCancel,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

type MessageDispatch = Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>;

export type TaskCancelAdmission = "run" | "reopen" | "refuse";

export const isTaskCancelled = (thread: Pick<OrchestrationV2AppThread, "taskCancel">) =>
  thread.taskCancel != null;

export function taskCancelAdmission(
  thread: Pick<OrchestrationV2AppThread, "taskCancel">,
  command: MessageDispatch,
): TaskCancelAdmission {
  const cancel = thread.taskCancel;
  if (cancel == null || command.dispatchMode.type === "note") return "run";
  const fromParent =
    cancel.parentEnvironmentId === undefined
      ? command.senderThreadId === cancel.parentThreadId
      : command.linkedSender?.threadId === cancel.parentThreadId &&
        command.linkedSender.environmentId === cancel.parentEnvironmentId;
  const fromPerson =
    command.createdBy === "user" &&
    command.scheduledTaskId === undefined &&
    (command.creationSource === "web" || command.creationSource === "mobile");
  return fromPerson || fromParent ? "reopen" : "refuse";
}

export function taskCancelRefusal(threadId: ThreadId, cancel: OrchestrationV2TaskCancel): string {
  const where =
    cancel.parentEnvironmentId === undefined ? "" : ` in environment ${cancel.parentEnvironmentId}`;
  const why = cancel.reason === undefined ? "" : ` (${cancel.reason})`;
  return `Thread ${threadId} is cancelled: "${cancel.parentTitle}" (thread ${cancel.parentThreadId}${where}) cancelled task ${cancel.taskId} at ${cancel.cancelledAt}${why}. It starts no run for agent messages or wakes. A person reopens it by sending a message in the thread; its parent resumes it by sending from thread ${cancel.parentThreadId}.`;
}

export const taskCancelCommand = (
  commandId: string,
  threadId: ThreadId,
  taskCancel: OrchestrationV2TaskCancel | null,
) => ({
  type: "thread.metadata.update" as const,
  commandId: CommandId.make(`${commandId}:task-cancel`),
  threadId,
  taskCancel,
});

export const reopenCancelledTask = <E, R, E2, R2>(
  command: OrchestrationV2ServerCommand,
  readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Pick<OrchestrationV2AppThread, "taskCancel">, E, R>,
  dispatch: (command: OrchestrationV2ServerCommand) => Effect.Effect<unknown, E2, R2>,
): Effect.Effect<void, E | E2, R | R2> =>
  command.type !== "message.dispatch"
    ? Effect.void
    : readThread(command.threadId).pipe(
        Effect.flatMap((thread) =>
          taskCancelAdmission(thread, command) === "reopen"
            ? dispatch(taskCancelCommand(command.commandId, command.threadId, null))
            : Effect.void,
        ),
        Effect.asVoid,
      );

export const delegatedTaskFields = (
  thread: Pick<OrchestrationV2AppThread, "delegatedFrom" | "taskCancel">,
) => ({
  ...(thread.delegatedFrom == null ? {} : { delegatedFrom: thread.delegatedFrom }),
  ...(thread.taskCancel == null ? {} : { taskCancel: thread.taskCancel }),
});
