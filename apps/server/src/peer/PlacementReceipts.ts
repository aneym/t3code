import { AgentPlacementReceipt } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentPlacementReceipt));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(AgentPlacementReceipt));

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const record = Effect.fn("PlacementReceipts.record")(
    function* (threadId: string, placement: AgentPlacementReceipt | undefined) {
      if (placement === undefined) return;
      const json = yield* encodeReceipt(placement);
      const recordedAt = placement.decidedAt ?? DateTime.toEpochMillis(yield* DateTime.now);
      yield* sql`INSERT INTO aneym_thread_placements (thread_id, placement_json, recorded_at)
        VALUES (${threadId}, ${json}, ${recordedAt})
        ON CONFLICT(thread_id) DO UPDATE SET placement_json = excluded.placement_json,
          recorded_at = excluded.recorded_at`;
    },
    Effect.ignore({ log: true }),
  );
  const read = Effect.fn("PlacementReceipts.read")(
    function* (threadId: string) {
      const rows = yield* sql<{ readonly placement_json: string }>`
        SELECT placement_json FROM aneym_thread_placements WHERE thread_id = ${threadId}`;
      const row = rows[0];
      return row === undefined ? undefined : yield* decodeReceipt(row.placement_json);
    },
    Effect.orElseSucceed(() => undefined),
  );
  return { record, read };
});
