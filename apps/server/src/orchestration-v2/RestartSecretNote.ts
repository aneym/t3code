export const restartSecretNote = ({
  label,
  clientRequestId,
  status = "pending",
}: {
  readonly label: string;
  readonly clientRequestId: string;
  readonly status?: "pending" | "saved" | "declined";
}) =>
  `T3 Code restarted while request_secret was waiting for "${label}". The request ${status === "pending" ? "is still open" : "has an answer"}. Call request_secret again with clientRequestId "${clientRequestId}" to get the answer. Do not ask for it in chat.`;
