import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  type OrchestrationV2ThreadHistoryPage,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { encodeThreadHistoryCursor, projectedRowEncodedBytes } from "./threadHistoryPaging.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(layerTest)("thread history page byte cap", (it) => {
  it.effect("pages a whole thread under a caller byte cap", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:page-bytes");
      const runId = RunId.make("run:page-bytes");
      const itemCount = 200;
      const maxBytes = 32_768;
      yield* projectionStore.apply({
        id: EventId.make("event:page-bytes:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:page-bytes"),
          title: "Page bytes",
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${runId}, ${threadId}, 1, 'codex', NULL, 'completed', ${nowIso}, ${nowIso},
          ${encodeJson({
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: "message:page-bytes",
            rootNodeId: "node:page-bytes",
            activeAttemptId: null,
            status: "completed",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      for (let ordinal = 0; ordinal < itemCount; ordinal += 1) {
        const id = `turn-item:page-bytes:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeJson({
              id,
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `item ${ordinal}`,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
              input: "x".repeat(ordinal % 50 === 0 ? 40_000 : 2_000),
              output: "ok",
              exitCode: 0,
            })}
          )
        `;
      }
      const snapshot = yield* projectionStore.getThreadSnapshot(threadId);
      let cursor: string | null = encodeThreadHistoryCursor({
        snapshotSequence: snapshot.snapshotSequence,
        sourceThreadId: threadId,
        sourceItemId: "absent",
        position: itemCount,
      });
      const ids: Array<string> = [];
      let pages = 0;
      while (cursor !== null) {
        const page: OrchestrationV2ThreadHistoryPage = yield* projectionStore.getThreadHistoryPage(
          threadId,
          cursor,
          undefined,
          undefined,
          undefined,
          maxBytes,
        );
        const bytes = page.items.reduce((sum, row) => sum + projectedRowEncodedBytes(row), 0);
        assert.isTrue(page.items.length === 1 || bytes <= maxBytes, `page of ${bytes} bytes`);
        pages += 1;
        ids.push(...page.items.map((row) => String(row.sourceItemId)));
        cursor = page.hasMoreHistory ? page.nextCursor : null;
      }
      assert.isAtLeast(pages, 12);
      assert.strictEqual(ids.length, itemCount);
      assert.strictEqual(new Set(ids).size, itemCount);
    }),
  );
});
