import { type HostLinkLaneBinding, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

interface LaneRow {
  readonly thread_id: string;
  readonly lane: string;
  readonly bound_at: string;
}

const toBinding = (row: LaneRow): HostLinkLaneBinding => ({
  threadId: ThreadId.make(row.thread_id),
  lane: row.lane,
  boundAt: row.bound_at,
});

export const listLanes = Effect.fn("HostLinkLaneStore.listLanes")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<LaneRow>`SELECT * FROM aneym_host_link_lanes ORDER BY bound_at`;
  return rows.map(toBinding);
});

export const bindLane = Effect.fn("HostLinkLaneStore.bindLane")(function* (
  binding: HostLinkLaneBinding,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO aneym_host_link_lanes (thread_id, lane, bound_at)
    VALUES (${binding.threadId}, ${binding.lane}, ${binding.boundAt})
    ON CONFLICT(thread_id) DO UPDATE SET lane = excluded.lane, bound_at = excluded.bound_at`;
});

export const unbindLane = Effect.fn("HostLinkLaneStore.unbindLane")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM aneym_host_link_lanes WHERE thread_id = ${threadId}`;
});
