import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";

export type Sender = Pick<
  OrchestrationV2ConversationMessage,
  "createdBy" | "creationSource" | "scheduledTaskId"
>;

export const PERSON_CREATION_SOURCES = ["web", "mobile"] as const;

export const personSent = (sender: Sender | undefined) =>
  sender?.createdBy === "user" &&
  (PERSON_CREATION_SOURCES as ReadonlyArray<string>).includes(sender.creationSource) &&
  sender.scheduledTaskId === undefined;
