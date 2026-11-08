import {
  messageSender,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type TurnItemId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

type NoteCommand = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
type EventOf<T extends OrchestrationV2DomainEvent["type"]> = Omit<
  Extract<OrchestrationV2DomainEvent, { readonly type: T }>,
  "id"
>;

export function quietNoteEvents(
  command: NoteCommand,
  now: DateTime.Utc,
  turnItem: { readonly id: TurnItemId; readonly ordinal: number },
): readonly [EventOf<"message.updated">, EventOf<"turn-item.updated">] {
  const shared = {
    threadId: command.threadId,
    runId: null,
    text: command.text,
    attachments: command.attachments,
    createdBy: command.createdBy,
    creationSource: command.creationSource,
    ...messageSender(command),
    quietNote: true,
  } as const;
  return [
    {
      type: "message.updated",
      threadId: command.threadId,
      occurredAt: now,
      payload: {
        ...shared,
        id: command.messageId,
        nodeId: null,
        role: "user",
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      type: "turn-item.updated",
      threadId: command.threadId,
      occurredAt: now,
      payload: {
        ...shared,
        id: turnItem.id,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: turnItem.ordinal,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        messageId: command.messageId,
        inputIntent: "turn_start",
      },
    },
  ];
}
