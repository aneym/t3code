import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const makeSubagentThreadListing = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return Effect.fn("ProjectionStore.listActiveSubagentThreadIds")(function* (options?: {
    readonly parentId?: ThreadId;
    readonly unsettledOnly?: boolean;
  }) {
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND json_extract(payload_json, '$.archivedAt') IS NULL
        AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
        ${options?.parentId === undefined ? sql`` : sql`AND json_extract(payload_json, '$.lineage.parentThreadId') = ${options.parentId}`}
        ${options?.unsettledOnly === true ? sql`AND json_extract(payload_json, '$.settledOverride') IS NOT 'settled'` : sql``}
    `;
    return rows.map((row) => ThreadId.make(row.thread_id));
  });
});
