import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE aneym_mcp_events_subscriptions ADD COLUMN cursor TEXT`;
  yield* sql`ALTER TABLE aneym_mcp_events_subscriptions ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'webhook'`;
  yield* sql`CREATE TABLE aneym_mcp_events_webhook_receipts (
    subscription_id TEXT NOT NULL,
    webhook_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (subscription_id, webhook_id)
  )`;
  yield* sql`CREATE INDEX aneym_mcp_events_webhook_receipts_received_idx
    ON aneym_mcp_events_webhook_receipts(received_at)`;
});
