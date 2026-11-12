import {
  mcpEventOfMessage,
  type OrchestrationV2ConversationMessage,
  type ThreadOrganizeRefusalReason,
} from "@t3tools/contracts";

export function queuedMessageRefusal(
  message: OrchestrationV2ConversationMessage,
  action: "edited" | "promoted to Steer",
): { readonly cause: string; readonly reason?: ThreadOrganizeRefusalReason } | undefined {
  if (mcpEventOfMessage(message) !== null)
    return {
      cause: `A queued MCP event is delivered by the server when the turn ends and cannot be ${action}.`,
      reason: "mcp_event_run",
    };
  if (message.delegatedCompletion !== undefined || message.notification !== undefined)
    return { cause: `Automatic completion deliveries cannot be ${action}.` };
  return undefined;
}
