import type * as SqlClient from "effect/sql/SqlClient";
import type { ChildOrigin } from "./DelegatedChildLimits.ts";

export interface ChildRow {
  readonly run_id: string;
  readonly thread_id: string;
  readonly status: string;
  readonly held: number | null;
  readonly worktree: number;
  readonly root_project_id: string | null;
  readonly provider: string | null;
  readonly parent: string | null;
  readonly class: string | null;
  readonly requested_at: string;
  readonly started_at: string | null;
}

export interface ActiveChild extends ChildOrigin {
  readonly child_thread_id: string;
  readonly root_project_id: string | null;
}

export const childQueries = (sql: SqlClient.SqlClient) => ({
  readChildren: (remote: boolean) => sql<ChildRow>`
    SELECT
      r.run_id,
      r.thread_id,
      r.status,
      json_extract(r.payload_json, '$.childStartHeld') AS held,
      json_extract(r.payload_json, '$.workspacePreparation') IS NOT NULL AS worktree,
      root.project_id AS root_project_id,
      json_extract(t.payload_json, '$.providerInstanceId') AS provider,
      json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent,
      CASE WHEN json_extract(r.payload_json, '$.childLight') = 1 THEN 'light' END AS class,
      r.requested_at,
      json_extract(r.payload_json, '$.startedAt') AS started_at
    FROM orchestration_v2_projection_runs r
    JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
    LEFT JOIN orchestration_v2_projection_threads root
      ON root.thread_id = COALESCE(json_extract(t.payload_json, '$.lineage.rootThreadId'), t.thread_id)
    WHERE r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
      AND r.status <> 'queued'
      AND t.deleted_at IS NULL
      AND (json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
        OR (${remote ? 1 : 0} = 1 AND json_extract(t.payload_json, '$.delegatedFrom') IS NOT NULL))
      AND COALESCE(json_extract(t.payload_json, '$.creationSource'), '') <> 'provider'
    ORDER BY r.requested_at, r.run_id
  `,
  readActiveChildren: sql<ActiveChild>`
    SELECT s.child_thread_id, root.project_id AS root_project_id,
      json_extract(t.payload_json, '$.providerInstanceId') AS provider,
      json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent,
      (SELECT CASE WHEN json_extract(lr.payload_json, '$.childLight') = 1 THEN 'light' END
        FROM orchestration_v2_projection_runs lr
        WHERE lr.thread_id = t.thread_id
        ORDER BY lr.ordinal DESC LIMIT 1) AS class,
      NULL AS started_at
    FROM orchestration_v2_projection_nodes n
      INDEXED BY orchestration_v2_projection_nodes_live_idx
    JOIN orchestration_v2_projection_subagents s ON s.subagent_id = n.node_id
    JOIN orchestration_v2_projection_threads t ON t.thread_id = s.child_thread_id
    LEFT JOIN orchestration_v2_projection_threads root
      ON root.thread_id = COALESCE(json_extract(t.payload_json, '$.lineage.rootThreadId'), t.thread_id)
    WHERE n.status IN ('pending', 'starting', 'running', 'waiting')
      AND n.kind = 'subagent'
      AND s.origin = 'app_owned'
      AND t.deleted_at IS NULL
  `,
});
