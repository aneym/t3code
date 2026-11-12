import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

export function threadReadFeedFields(
  item: OrchestrationV2TurnItem,
  message: OrchestrationV2ConversationMessage | undefined,
) {
  return {
    ...(item.type === "assistant_message" && item.streaming ? { streaming: true as const } : {}),
    ...(item.type === "user_message" && message !== undefined && message.attachments.length > 0
      ? {
          attachments: message.attachments.map(({ id, type, name, mimeType }) => ({
            id,
            type,
            name,
            mimeType,
          })),
        }
      : {}),
  };
}
