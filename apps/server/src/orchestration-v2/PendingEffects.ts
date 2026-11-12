import type { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutboxModel.ts";

export function delegatedTasksEffect(
  type: "delegated-tasks.stop" | "delegated-tasks.resume",
  command: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly reason?: string | undefined;
  },
): PendingOrchestrationEffectV2 {
  return {
    id: `effect:${command.commandId}:${type}`,
    commandId: command.commandId,
    threadId: command.threadId,
    request:
      type === "delegated-tasks.stop" && command.reason !== undefined
        ? { type, reason: command.reason }
        : { type },
  };
}

export function pendingThreadTitleGenerationEffect(
  commandId: CommandId,
  threadId: ThreadId,
  kind:
    | { readonly type: "initial"; readonly messageId: MessageId }
    | { readonly type: "regenerate" },
): PendingOrchestrationEffectV2 {
  return {
    id: `effect:${commandId}:thread-title.generate`,
    commandId,
    threadId,
    request: { type: "thread-title.generate", kind },
  };
}
