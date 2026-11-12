import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    WITH ordered AS (
      SELECT project_id, ROW_NUMBER() OVER (ORDER BY pin_order, project_id) AS position
      FROM projection_projects WHERE pin_order IS NOT NULL
    )
    UPDATE projection_projects
    SET pinned_at = (
      SELECT strftime('%Y-%m-%dT%H:%M:%fZ', '1970-01-01', printf('+%d seconds', position))
      FROM ordered WHERE ordered.project_id = projection_projects.project_id
    )
    WHERE pin_order IS NOT NULL AND pinned_at IS NULL
  `;
});
