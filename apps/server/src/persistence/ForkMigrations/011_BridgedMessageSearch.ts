import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  createMessageSearchTriggers,
  indexedMessageCondition,
  indexedMessageText,
} from "../../orchestration-v2/messageSearchIndex.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const index = yield* sql`
    SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'
  `;
  if (index.length === 0) return;

  yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_message_search_insert`;
  yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_message_search_update`;
  yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_message_search_delete`;
  yield* createMessageSearchTriggers(sql);
  yield* sql`
    INSERT INTO orchestration_v2_message_search (rowid, text)
    SELECT messages.rowid, ${indexedMessageText(sql, "messages.payload_json")}
    FROM orchestration_v2_projection_messages AS messages
    WHERE messages.role = 'user'
      AND json_extract(messages.payload_json, '$.createdBy') = 'agent'
      AND ${indexedMessageCondition(sql)}
      AND json_extract(messages.payload_json, '$.text') IS NOT NULL
      AND messages.rowid NOT IN (SELECT rowid FROM orchestration_v2_message_search)
  `;
});
