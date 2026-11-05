import {
  McpEventsServer,
  type McpEventsSubscription,
  type McpEventsSubscriptionStatus,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface SubscriptionRow {
  readonly id: string;
  readonly thread_id: string;
  readonly server_json: string;
  readonly server_key: string;
  readonly name: string;
  readonly arguments_json: string;
  readonly token_hash: string;
  readonly status: McpEventsSubscriptionStatus;
  readonly remote_id: string | null;
  readonly refresh_before: string | null;
  readonly subscribed_at: string | null;
  readonly last_error: string | null;
  readonly last_delivery_at: string | null;
  readonly deliveries: number;
  readonly created_at: string;
}

const decodeServer = Schema.decodeUnknownSync(Schema.fromJsonString(McpEventsServer));

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function toSubscription(row: SubscriptionRow): McpEventsSubscription {
  return {
    id: row.id,
    threadId: ThreadId.make(row.thread_id),
    server: decodeServer(row.server_json),
    name: row.name,
    arguments: JSON.parse(row.arguments_json) as Record<string, unknown>,
    status: row.status,
    remoteId: row.remote_id,
    refreshBefore: row.refresh_before,
    lastError: row.last_error,
    lastDeliveryAt: row.last_delivery_at,
    deliveries: row.deliveries,
    createdAt: row.created_at,
  };
}

export const findById = Effect.fn("McpEventsStore.findById")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql<SubscriptionRow>`SELECT * FROM aneym_mcp_events_subscriptions WHERE id = ${id}`;
  return rows[0];
});

export const findByKey = Effect.fn("McpEventsStore.findByKey")(function* (key: {
  readonly threadId: string;
  readonly serverKey: string;
  readonly name: string;
  readonly argumentsJson: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<SubscriptionRow>`SELECT * FROM aneym_mcp_events_subscriptions
    WHERE thread_id = ${key.threadId} AND server_key = ${key.serverKey}
      AND name = ${key.name} AND arguments_json = ${key.argumentsJson}`;
  return rows[0];
});

export const list = Effect.fn("McpEventsStore.list")(function* (threadId: string | undefined) {
  const sql = yield* SqlClient.SqlClient;
  return threadId === undefined
    ? yield* sql<SubscriptionRow>`SELECT * FROM aneym_mcp_events_subscriptions ORDER BY created_at`
    : yield* sql<SubscriptionRow>`SELECT * FROM aneym_mcp_events_subscriptions
        WHERE thread_id = ${threadId} ORDER BY created_at`;
});

export const insertPending = Effect.fn("McpEventsStore.insertPending")(function* (row: {
  readonly id: string;
  readonly threadId: string;
  readonly serverJson: string;
  readonly serverKey: string;
  readonly name: string;
  readonly argumentsJson: string;
  readonly tokenHash: string;
  readonly createdAt: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO aneym_mcp_events_subscriptions
    (id, thread_id, server_json, server_key, name, arguments_json, token_hash, status, created_at)
    VALUES (${row.id}, ${row.threadId}, ${row.serverJson}, ${row.serverKey}, ${row.name},
      ${row.argumentsJson}, ${row.tokenHash}, 'pending', ${row.createdAt})`;
});

export const markSubscribed = Effect.fn("McpEventsStore.markSubscribed")(function* (input: {
  readonly id: string;
  readonly remoteId: string | null;
  readonly refreshBefore: string | null;
  readonly subscribedAt: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE aneym_mcp_events_subscriptions
    SET status = 'active', remote_id = ${input.remoteId}, refresh_before = ${input.refreshBefore},
      subscribed_at = ${input.subscribedAt}, last_error = NULL
    WHERE id = ${input.id}`;
});

export const markStatus = Effect.fn("McpEventsStore.markStatus")(function* (
  id: string,
  status: McpEventsSubscriptionStatus,
  lastError: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE aneym_mcp_events_subscriptions SET status = ${status}, last_error = ${lastError}
    WHERE id = ${id}`;
});

export const updateServer = Effect.fn("McpEventsStore.updateServer")(function* (
  id: string,
  serverJson: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE aneym_mcp_events_subscriptions SET server_json = ${serverJson} WHERE id = ${id}`;
});

export const remove = Effect.fn("McpEventsStore.remove")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM aneym_mcp_events_deliveries WHERE subscription_id = ${id}`;
  yield* sql`DELETE FROM aneym_mcp_events_subscriptions WHERE id = ${id}`;
});

export const claimDelivery = Effect.fn("McpEventsStore.claimDelivery")(function* (
  subscriptionId: string,
  eventId: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM aneym_mcp_events_deliveries WHERE received_at <= ${now - DELIVERY_RETENTION_MS}`;
  const claimed = yield* sql<{ event_id: string }>`INSERT INTO aneym_mcp_events_deliveries
    (subscription_id, event_id, received_at) VALUES (${subscriptionId}, ${eventId}, ${now})
    ON CONFLICT (subscription_id, event_id) DO NOTHING RETURNING event_id`;
  if (claimed.length > 0) return "claimed" as const;
  const rows = yield* sql<{ dispatched: number }>`SELECT dispatched FROM aneym_mcp_events_deliveries
    WHERE subscription_id = ${subscriptionId} AND event_id = ${eventId}`;
  return rows[0]?.dispatched === 1 ? ("dispatched" as const) : ("pending" as const);
});

export const markDispatched = Effect.fn("McpEventsStore.markDispatched")(function* (
  subscriptionId: string,
  eventId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE aneym_mcp_events_deliveries SET dispatched = 1
    WHERE subscription_id = ${subscriptionId} AND event_id = ${eventId}`;
});

export const releaseDelivery = Effect.fn("McpEventsStore.releaseDelivery")(function* (
  subscriptionId: string,
  eventId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM aneym_mcp_events_deliveries
    WHERE subscription_id = ${subscriptionId} AND event_id = ${eventId}`;
});

export const recordDelivery = Effect.fn("McpEventsStore.recordDelivery")(function* (
  id: string,
  at: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE aneym_mcp_events_subscriptions
    SET deliveries = deliveries + 1, last_delivery_at = ${at} WHERE id = ${id}`;
});
