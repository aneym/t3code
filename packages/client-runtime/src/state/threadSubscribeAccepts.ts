import { chatSessionActive } from "../chatSession.ts";

export function threadSubscribeAccepts(acceptBoundedSnapshot: boolean) {
  if (!acceptBoundedSnapshot) return {};
  return {
    acceptBoundedSnapshot: true as const,
    ...(chatSessionActive() ? {} : { acceptDeferredWork: true as const }),
    acceptCompactTurnItems: true as const,
    acceptCompactIds: true as const,
  };
}
