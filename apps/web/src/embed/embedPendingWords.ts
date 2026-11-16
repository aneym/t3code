import type { EmbedPendingState } from "./embedPendingSends";

export const PENDING_STATE_WORDS: Record<EmbedPendingState, string> = {
  sending: "Sending",
  waiting: "Waiting",
  failed: "Not sent",
};

export const PENDING_WORDS = {
  separator: " · ",
  sendNow: "Send now",
  discard: "Discard",
  list: "Your messages not sent yet",
  row: (state: EmbedPendingState) => `${PENDING_STATE_WORDS[state]}: your message`,
  noAnswer: "No answer from the app, so this wasn't sent.",
  notConnected: "The app isn't connected, so this wasn't sent.",
  notSentToast: "Not sent",
} as const;
