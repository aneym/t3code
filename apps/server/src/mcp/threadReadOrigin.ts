import { messageSender, type OrchestrationV2ConversationMessage } from "@t3tools/contracts";

export function threadReadOrigin(message: OrchestrationV2ConversationMessage | undefined) {
  const notification = message?.notification;
  return {
    createdBy: message?.createdBy ?? null,
    creationSource: message?.creationSource ?? null,
    ...messageSender(message),
    ...(notification === undefined
      ? {}
      : {
          notification: {
            source: notification.source,
            outcome: notification.outcome,
            summary: notification.summary,
          },
        }),
    ...(message?.delegatedCompletion === undefined
      ? {}
      : { delegatedCompletion: message.delegatedCompletion }),
  };
}
