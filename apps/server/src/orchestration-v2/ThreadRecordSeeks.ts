import type {
  NodeId,
  OrchestrationV2ContextTransfer,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

export interface SettledRecordFilter {
  readonly turnItemRunId?: RunId;
  readonly turnItemRunIds?: ReadonlyArray<RunId | null>;
  readonly turnItemNodeIds?: ReadonlyArray<NodeId>;
  readonly turnItemTypes?: ReadonlyArray<OrchestrationV2TurnItem["type"]>;
  readonly contextTransferStatuses?: ReadonlyArray<OrchestrationV2ContextTransfer["status"]>;
  readonly omitSettledLeafNodes?: boolean;
  /**
   * Skips ended subagents whose completion was acknowledged, delivered or disposed, unless their
   * run is active or `except` names them.
   */
  readonly omitSettledSubagents?: true | { readonly except: ReadonlyArray<NodeId> };
  /**
   * Also skips the provider thread of each subagent that `omitSettledSubagents: true` skips, and
   * with `omitSettledLeafNodes` its node. A provider thread that shares a provider session with
   * the thread stays.
   */
  readonly omitSettledSubagentRecords?: boolean;
}

const encodeIdList = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const CONVERSATION_INDEX_EXCLUDED_TYPES: ReadonlyArray<OrchestrationV2TurnItem["type"]> = [
  "command_execution",
  "reasoning",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
];

const readsConversationItemsOnly = (filter: SettledRecordFilter | undefined) =>
  filter?.turnItemTypes !== undefined &&
  filter.turnItemRunId === undefined &&
  filter.turnItemRunIds === undefined &&
  filter.turnItemNodeIds === undefined &&
  filter.turnItemTypes.every((type) => !CONVERSATION_INDEX_EXCLUDED_TYPES.includes(type));

export const makeThreadRecordSeeks = (sql: SqlClient.SqlClient) => {
  const excludedTypes = sql.literal(
    `(${CONVERSATION_INDEX_EXCLUDED_TYPES.map((type) => `'${type}'`).join(", ")})`,
  );

  const settledSubagent = (row: Statement.Fragment) => sql`(
    ${row}.status IN ('completed', 'failed', 'cancelled', 'interrupted')
    AND COALESCE(${row}.completion_delivery_state, '') IN ('acknowledged', 'delivered', 'disposed')
    AND NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runs AS run
      WHERE run.run_id = ${row}.run_id
        AND run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
    )
  )`;

  const unsettledSubagentRowids = (threadId: ThreadId) => sql`
    SELECT candidate.rowid
    FROM orchestration_v2_projection_subagents AS candidate
      INDEXED BY orchestration_v2_projection_subagents_settled_idx
    WHERE candidate.thread_id = ${threadId}
      AND NOT ${settledSubagent(sql`candidate`)}
  `;

  const turnItemsWhere = (threadId: ThreadId, filter: SettledRecordFilter | undefined) =>
    readsConversationItemsOnly(filter)
      ? sql`INDEXED BY orchestration_v2_projection_turn_items_conversation_idx
        WHERE thread_id = ${threadId} AND type NOT IN ${excludedTypes}`
      : sql`WHERE thread_id = ${threadId}`;

  const settledSubagentNodeRowids = (threadId: ThreadId) => sql`
    SELECT settled_node.rowid
    FROM orchestration_v2_projection_subagents AS settled
      INDEXED BY orchestration_v2_projection_subagents_thread_idx
    CROSS JOIN orchestration_v2_projection_nodes AS settled_node
      ON settled_node.node_id = settled.subagent_id
    WHERE settled.thread_id = ${threadId}
      AND settled.rowid NOT IN (${unsettledSubagentRowids(threadId)})
  `;

  const nodesWhere = (threadId: ThreadId, filter: SettledRecordFilter | undefined) =>
    filter?.omitSettledLeafNodes === true
      ? sql`node.rowid IN (
          SELECT rowid FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId}
            AND (kind IN ('tool_call', 'assistant_message', 'reasoning')
              AND status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
              AND run_id IS NOT NULL) = 0
          ${filter.omitSettledSubagentRecords === true ? sql`EXCEPT ${settledSubagentNodeRowids(threadId)}` : sql``}
          UNION ALL
          SELECT rowid FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId}
            AND run_id IN (
              SELECT run_id FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId}
                AND status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
            )
            AND kind IN ('tool_call', 'assistant_message', 'reasoning')
            AND status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
        )`
      : sql`node.thread_id = ${threadId}`;

  const subagentsSettledFilter = (threadId: ThreadId, filter: SettledRecordFilter | undefined) =>
    filter?.omitSettledSubagents === true
      ? sql`AND subagent.rowid IN (${unsettledSubagentRowids(threadId)})`
      : filter?.omitSettledSubagents !== undefined
        ? sql`AND (
            subagent_id IN (SELECT value FROM json_each(${encodeIdList(filter.omitSettledSubagents.except)}))
            OR NOT ${settledSubagent(sql`subagent`)}
          )`
        : sql``;

  const subagentProviderThreads = (threadId: ThreadId, filter: SettledRecordFilter | undefined) =>
    filter?.omitSettledSubagentRecords === true
      ? sql`provider_thread_id IN (
          SELECT provider_thread_id
          FROM orchestration_v2_projection_subagents
          WHERE rowid IN (${unsettledSubagentRowids(threadId)})
            AND provider_thread_id IS NOT NULL
        )
        OR (provider_session_id IN (
            SELECT provider_session_id
            FROM orchestration_v2_projection_provider_session_bindings
            WHERE thread_id = ${threadId}
          )
          AND EXISTS (
            SELECT 1 FROM orchestration_v2_projection_subagents AS owner
            WHERE owner.provider_thread_id =
                orchestration_v2_projection_provider_threads.provider_thread_id
              AND owner.thread_id = ${threadId}
          ))`
      : sql`provider_thread_id IN (
          SELECT provider_thread_id
          FROM orchestration_v2_projection_subagents
          WHERE thread_id = ${threadId}
            AND provider_thread_id IS NOT NULL
        )`;

  const nodesOwningProviderThreads = (threadId: ThreadId) => sql`
    SELECT owner.node_id
    FROM orchestration_v2_projection_provider_threads AS owned
      INDEXED BY orchestration_v2_projection_provider_threads_owner_idx
    CROSS JOIN orchestration_v2_projection_nodes AS owner
      ON owner.node_id = owned.owner_node_id
    WHERE owned.owner_node_id IS NOT NULL AND owner.thread_id = ${threadId}
  `;

  const contextTransfersWhere = (threadId: ThreadId, filter: SettledRecordFilter | undefined) =>
    filter?.contextTransferStatuses === undefined
      ? sql`source_thread_id = ${threadId} OR target_thread_id = ${threadId}`
      : sql`rowid IN (
          SELECT rowid FROM orchestration_v2_projection_context_transfers
          WHERE source_thread_id = ${threadId}
            AND status IN (SELECT value FROM json_each(${encodeIdList(filter.contextTransferStatuses)}))
          UNION
          SELECT rowid FROM orchestration_v2_projection_context_transfers
          WHERE target_thread_id = ${threadId}
            AND status IN (SELECT value FROM json_each(${encodeIdList(filter.contextTransferStatuses)}))
        )`;

  return {
    turnItemsWhere,
    nodesWhere,
    subagentsSettledFilter,
    subagentProviderThreads,
    nodesOwningProviderThreads,
    contextTransfersWhere,
  };
};
