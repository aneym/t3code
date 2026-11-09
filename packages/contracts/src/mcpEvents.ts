import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

export const McpEventsHttpServer = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^https?:\/\//)).annotate({
    description: "Streamable HTTP MCP endpoint.",
  }),
  headersFile: Schema.optional(
    Schema.String.annotate({
      description:
        "Absolute path of a file of `Name: value` header lines, such as ~/.rails/key. Read on each call, never stored.",
    }),
  ),
});

export const McpEventsStdioServer = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1)),
  args: Schema.optional(Schema.Array(Schema.String)),
});

export const McpEventsServer = Schema.Union([McpEventsHttpServer, McpEventsStdioServer]).annotate({
  description: "The MCP server that emits the events: `{url, headersFile?}` or `{command, args?}`.",
});
export type McpEventsServer = typeof McpEventsServer.Type;

export const McpEventsSubscriptionStatus = Schema.Literals([
  "pending",
  "active",
  "failing",
  "terminated",
]);
export type McpEventsSubscriptionStatus = typeof McpEventsSubscriptionStatus.Type;

export const McpEventsSubscription = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  server: McpEventsServer,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  status: McpEventsSubscriptionStatus,
  remoteId: Schema.NullOr(Schema.String),
  refreshBefore: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  lastDeliveryAt: Schema.NullOr(Schema.String),
  deliveries: Schema.Int,
  createdAt: Schema.String,
});
export type McpEventsSubscription = typeof McpEventsSubscription.Type;

export const McpEventsSubscribeInput = Schema.Struct({
  server: McpEventsServer,
  name: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Event name from the server's events/list, such as comment.created.",
  }),
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Subscription filters matching the event's inputSchema.",
  }),
  threadId: Schema.optional(ThreadId).annotate({
    description: "Thread that receives the events. Defaults to the calling thread.",
  }),
  ttlMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "Suggested lifetime; T3 refreshes before the server's refreshBefore.",
  }),
});
export type McpEventsSubscribeInput = typeof McpEventsSubscribeInput.Type;

export const McpEventsListInput = Schema.Struct({
  threadId: Schema.optional(ThreadId).annotate({
    description: "Only this thread's subscriptions.",
  }),
  server: Schema.optional(McpEventsServer).annotate({
    description: "Also return this server's events/list catalog.",
  }),
});
export type McpEventsListInput = typeof McpEventsListInput.Type;

export const McpEventsListResult = Schema.Struct({
  subscriptions: Schema.Array(McpEventsSubscription),
  catalog: Schema.optional(Schema.Unknown),
});
export type McpEventsListResult = typeof McpEventsListResult.Type;

export const McpEventsUnsubscribeInput = Schema.Struct({
  subscriptionId: Schema.String.check(Schema.isMinLength(1)),
});
export type McpEventsUnsubscribeInput = typeof McpEventsUnsubscribeInput.Type;

export const McpEventsUnsubscribeResult = Schema.Struct({
  subscriptionId: Schema.String,
  removed: Schema.Boolean,
  remote: Schema.String,
});
export type McpEventsUnsubscribeResult = typeof McpEventsUnsubscribeResult.Type;

export const McpEventOccurrence = Schema.Struct({
  eventId: Schema.String,
  name: Schema.String,
  timestamp: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
});
export type McpEventOccurrence = typeof McpEventOccurrence.Type;

export const McpEventMessageSource = Schema.Struct({
  name: Schema.String,
  server: Schema.String,
});
export type McpEventMessageSource = typeof McpEventMessageSource.Type;

export const MCP_EVENT_MESSAGE_ID_PREFIX = "message:mcp-events:";

export function mcpEventOfMessage(
  message:
    | { readonly id: string; readonly mcpEvent?: McpEventMessageSource | undefined }
    | undefined,
): Partial<McpEventMessageSource> | null {
  if (message?.mcpEvent !== undefined) return message.mcpEvent;
  return message?.id.startsWith(MCP_EVENT_MESSAGE_ID_PREFIX) ? {} : null;
}
