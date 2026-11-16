import type { EmbedPendingState } from "./embedPendingSends";

export const PENDING_STATE_WORDS: Record<EmbedPendingState, string> = {
  sending: "Sending",
  waiting: "Waiting",
  failed: "Not sent",
};

export const PENDING_WORDS = {
  separator: "·",
  sendNow: "Send now",
  discard: "Discard",
  list: "Your messages not sent yet",
  row: (state: EmbedPendingState) => `${PENDING_STATE_WORDS[state]}: your message`,
  noAnswer: "Rails didn't answer.",
  notConnected: "Rails isn't connected.",
  notSentToast: "Not sent",
} as const;
