import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

export function threadReadFeedFields(item: OrchestrationV2TurnItem) {
  return item.type === "assistant_message" && item.streaming ? { streaming: true as const } : {};
}
