export const RUN_LOCAL_MODEL_MESSAGE_PREFIX = "quota-fallback:";

export const keepsThreadModelSelection = (messageId: string) =>
  messageId.startsWith(RUN_LOCAL_MODEL_MESSAGE_PREFIX);

export const fallbackMessageId = (runId: string) => `${RUN_LOCAL_MODEL_MESSAGE_PREFIX}${runId}`;
