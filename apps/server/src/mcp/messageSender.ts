import type { MessageSender } from "@t3tools/contracts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export const mcpMessageSender = (scope: McpInvocationScope): MessageSender => {
  if (scope.thread !== undefined) return { senderThreadId: scope.thread.threadId };
  const sender = scope.client?.linked === true ? scope.client.sender : undefined;
  return sender === undefined
    ? {}
    : { senderThreadId: sender.threadId, senderEnvironmentId: sender.environmentId };
};
