export const restartSecretNote = ({
  label,
  clientRequestId,
}: {
  readonly label: string;
  readonly clientRequestId: string;
}) =>
  `T3 Code restarted while request_secret was waiting for "${label}". The request is still open. Call request_secret again with clientRequestId "${clientRequestId}" to get the answer. Do not ask for it in chat.`;
