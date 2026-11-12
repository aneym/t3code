import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS aneym_mcp_events_subscriptions (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      server_json TEXT NOT NULL,
      server_key TEXT NOT NULL,
      name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      remote_id TEXT,
      refresh_before TEXT,
      subscribed_at TEXT,
      last_error TEXT,
      last_delivery_at TEXT,
      deliveries INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS aneym_mcp_events_subscriptions_key_idx
    ON aneym_mcp_events_subscriptions(thread_id, server_key, name, arguments_json)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS aneym_mcp_events_deliveries (
      subscription_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      dispatched INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (subscription_id, event_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS aneym_mcp_events_deliveries_received_idx
    ON aneym_mcp_events_deliveries(received_at)
  `;
});
