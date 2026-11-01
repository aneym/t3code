import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export interface SubagentThreadListingOptions {
  readonly parentId?: ThreadId;
  readonly unsettledOnly?: boolean;
  readonly settledParentOnly?: boolean;
  readonly threadId?: ThreadId;
}

export const makeSubagentThreadListing = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return Effect.fn("ProjectionStore.listActiveSubagentThreadIds")(function* (
    options?: SubagentThreadListingOptions,
  ) {
    if (options?.settledParentOnly === true) {
      const rows = yield* sql<{ readonly thread_id: string }>`
        SELECT child.thread_id
        FROM orchestration_v2_projection_threads parent
          INDEXED BY aneym_settled_parents_idx
        CROSS JOIN orchestration_v2_projection_threads child
          INDEXED BY aneym_unsettled_children_parent_idx
        WHERE parent.deleted_at IS NULL
          AND json_extract(parent.payload_json, '$.settledOverride') = 'settled'
          AND child.deleted_at IS NULL
          AND json_extract(child.payload_json, '$.archivedAt') IS NULL
          AND json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
          AND json_extract(child.payload_json, '$.settledOverride') IS NULL
          AND json_extract(child.payload_json, '$.lineage.parentThreadId') = +parent.thread_id
          ${options.parentId === undefined ? sql`` : sql`AND parent.thread_id = ${options.parentId}`}
          ${options.threadId === undefined ? sql`` : sql`AND child.thread_id = ${options.threadId}`}
      `;
      return rows.map((row) => ThreadId.make(row.thread_id));
    }
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
