import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_user_message_idx
    ON orchestration_v2_projection_runs(thread_id, CAST(json_extract(payload_json, '$.userMessageId') AS TEXT))
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_provider_turns_attempt_idx
    ON orchestration_v2_projection_provider_turns(thread_id, run_attempt_id)
  `;
});
