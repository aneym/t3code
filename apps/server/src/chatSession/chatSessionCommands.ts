import type { OrchestrationV2Command, ThreadId } from "@t3tools/contracts";

type Command<T extends OrchestrationV2Command["type"]> = Extract<
  OrchestrationV2Command,
  { readonly type: T }
>;

const pick = <A extends object, K extends keyof A>(
  value: A,
  keys: ReadonlyArray<K>,
): Pick<A, K> => {
  const picked: Partial<Pick<A, K>> = {};
  for (const key of keys) if (value[key] !== undefined) picked[key] = value[key];
  return picked as Pick<A, K>;
};

const heldThreadIds = (command: {
  readonly threadId: ThreadId;
  readonly heldByThreadId?: ThreadId | undefined;
}) =>
  command.heldByThreadId === undefined
    ? [command.threadId]
    : [command.threadId, command.heldByThreadId];

export function chatCommandThreadIds(
  command: OrchestrationV2Command,
): ReadonlyArray<ThreadId> | null {
  switch (command.type) {
    case "message.dispatch":
      return command.dispatchMode.type === "defer_start" ? null : [command.threadId];
    case "run.interrupt":
    case "queue.resume":
      return heldThreadIds(command);
    case "thread.stop":
    case "subagent.stop":
    case "queued-message.promote-to-steer":
    case "queued-run.start":
    case "queued-run.reorder":
    case "queued-run.cancel":
    case "queued-run.edit":
    case "runtime-request.respond":
    case "thread.user-input.dismiss":
    case "thread.visit":
    case "thread.mark-unread":
      return [command.threadId];
    default:
      return null;
  }
}

export function chatCommandAttachmentIds(command: OrchestrationV2Command): ReadonlyArray<string> {
  switch (command.type) {
    case "message.dispatch":
      return command.attachments.map((attachment) => attachment.id ?? "");
    case "queued-run.edit":
      return (command.attachments ?? []).map((attachment) => attachment.id ?? "");
    case "runtime-request.respond":
      return Object.values(command.attachmentsByQuestionId ?? {}).flatMap((attachments) =>
        attachments.map((attachment) => attachment.id),
      );
    default:
      return [];
  }
}

const rebuildMessageDispatch = (
  command: Command<"message.dispatch">,
): Command<"message.dispatch"> => ({
  type: command.type,
  commandId: command.commandId,
  threadId: command.threadId,
  messageId: command.messageId,
  text: command.text,
  attachments: command.attachments,
  dispatchMode: command.dispatchMode,
  createdBy: "user",
  creationSource: "web",
  ...pick(command, [
    "context",
    "titleSeed",
    "deliveryIntent",
    "freshContext",
    "restartContinuationOfRunId",
    "usageLimitContinuationOfRunId",
    "manualContinuationOfRunId",
    "steerFollowUpOfRunId",
    "steerFollowUpAfterRunOrdinal",
    "usageLimitRecoveryRequestId",
  ]),
});

export function rebuildChatCommand(command: OrchestrationV2Command): OrchestrationV2Command {
  switch (command.type) {
    case "message.dispatch":
      return rebuildMessageDispatch(command);
    case "thread.stop":
      return pick(command, ["type", "commandId", "threadId", "reason", "stopDelegatedTasks"]);
    case "run.interrupt":
      return pick(command, [
        "type",
        "commandId",
        "threadId",
        "runId",
        "reason",
        "holdQueue",
        "heldByThreadId",
      ]);
    case "queue.resume":
      return pick(command, ["type", "commandId", "threadId", "heldByThreadId"]);
    case "subagent.stop":
      return pick(command, ["type", "commandId", "threadId", "runId", "subagentId"]);
    case "queued-message.promote-to-steer":
      return pick(command, ["type", "commandId", "threadId", "queuedRunId", "targetRunId"]);
    case "queued-run.start":
    case "queued-run.cancel":
      return pick(command, ["type", "commandId", "threadId", "runId"]);
    case "queued-run.reorder":
      return pick(command, ["type", "commandId", "threadId", "runId", "beforeRunId"]);
    case "queued-run.edit":
      return pick(command, [
        "type",
        "commandId",
        "threadId",
        "runId",
        "text",
        "context",
        "attachments",
      ]);
    case "runtime-request.respond":
      return pick(command, [
        "type",
        "commandId",
        "threadId",
        "requestId",
        "decision",
        "feedback",
        "answers",
        "attachmentsByQuestionId",
      ]);
    case "thread.user-input.dismiss":
      return pick(command, ["type", "commandId", "threadId", "requestId"]);
    case "thread.visit":
      return pick(command, ["type", "commandId", "threadId", "visitedAt", "opened", "searchQuery"]);
    case "thread.mark-unread":
      return pick(command, ["type", "commandId", "threadId"]);
    default:
      return command;
  }
}
