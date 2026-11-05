import {
  McpEventsListInput,
  McpEventsListResult,
  McpEventsSubscribeInput,
  McpEventsSubscription,
  McpEventsUnsubscribeInput,
  McpEventsUnsubscribeResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import { McpEventsService } from "../../../mcpEvents/McpEventsService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpEventsService, McpInvocationContext, ThreadManagementService],
};

export const McpEventsToolkit = Toolkit.make(
  Tool.make("t3_events_subscribe", {
    ...shared,
    description:
      "Subscribe a thread to an MCP server's events (MCP Events webhook mode). Each verified event wakes the thread or queues into its running turn. Same server, name and arguments refreshes the existing subscription. Needs the MCP Events setting on.",
    parameters: McpEventsSubscribeInput,
    success: McpEventsSubscription,
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_events_list", {
    ...shared,
    description:
      "List MCP Events subscriptions and their status. Pass `server` to also get its events/list catalog.",
    parameters: McpEventsListInput,
    success: McpEventsListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_events_unsubscribe", {
    ...shared,
    description: "Stop an MCP Events subscription: calls events/unsubscribe and deletes it here.",
    parameters: McpEventsUnsubscribeInput,
    success: McpEventsUnsubscribeResult,
  })
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, true),
);
