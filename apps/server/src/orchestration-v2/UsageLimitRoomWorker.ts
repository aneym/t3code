import { CommandId, ThreadId, type ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { continueThread } from "./ThreadContinue.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { limitRetryStreak, ROOM_CONTINUATION_COMMAND_PREFIX } from "./UsageLimitBackoff.ts";

function usageRoomCheckedAt(
  provider: Pick<ServerProvider, "usageLimits">,
  model: string,
): number | null {
  const limits = provider.usageLimits;
  if (limits === undefined || limits.unavailable !== undefined) return null;
  const windows = limits.windows.filter(
    (window) => window.modelIds === undefined || window.modelIds.includes(model),
  );
  if (windows.length === 0 || windows.some((window) => window.usedPercent >= 100)) return null;
  const checkedAt = Date.parse(limits.checkedAt);
  return Number.isFinite(checkedAt) ? checkedAt : null;
}

const makeRelease = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  return Effect.fn("UsageLimitRoomWorker.release")(function* (
    providers: ReadonlyArray<ServerProvider>,
  ) {
    if (!(yield* settings.getSettings).autoResumeLimitedThreads) return;
    const withLimits = providers.filter((provider) => provider.usageLimits !== undefined);
    if (withLimits.length === 0) return;
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly run_id: string;
      readonly provider_instance_id: string;
      readonly model: string | null;
      readonly failed_at: string;
    }>`
      SELECT t.thread_id, r.run_id,
        json_extract(r.payload_json, '$.providerInstanceId') AS provider_instance_id,
        json_extract(r.payload_json, '$.modelSelection.model') AS model,
        item.updated_at AS failed_at
      FROM orchestration_v2_projection_threads t
      INNER JOIN orchestration_v2_projection_runs r ON r.run_id = (
        SELECT latest.run_id FROM orchestration_v2_projection_runs latest
        WHERE latest.thread_id = t.thread_id
          AND latest.status <> 'queued'
          AND NOT (
            latest.status = 'cancelled'
            AND json_extract(latest.payload_json, '$.startedAt') IS NULL
          )
        ORDER BY latest.completed_at IS NULL DESC, latest.completed_at DESC,
          latest.ordinal DESC, latest.run_id DESC
        LIMIT 1
      ) AND r.status = 'failed'
      INNER JOIN orchestration_v2_projection_turn_items item ON item.turn_item_id = (
        SELECT error.turn_item_id FROM orchestration_v2_projection_turn_items error
        WHERE error.thread_id = t.thread_id AND error.run_id = r.run_id
          AND error.type = 'error' AND error.status = 'failed'
          AND error.node_id IS json_extract(r.payload_json, '$.rootNodeId')
        ORDER BY error.updated_at DESC, error.ordinal DESC, error.turn_item_id DESC
        LIMIT 1
      )
      WHERE t.deleted_at IS NULL
        AND t.thread_id IN (
          SELECT failure.thread_id FROM orchestration_v2_projection_turn_items failure
          WHERE failure.type = 'error' AND failure.status = 'failed'
            AND json_extract(failure.payload_json, '$.failure.class') = 'usage_limit'
        )
        AND json_extract(item.payload_json, '$.failure.class') = 'usage_limit'
        AND json_extract(t.payload_json, '$.archivedAt') IS NULL
        AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'
        AND (
          json_extract(t.payload_json, '$.snoozedUntil') IS NULL
          OR julianday(json_extract(t.payload_json, '$.snoozedUntil')) <= julianday(${nowIso})
        )
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_threads parent
          WHERE json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
            AND parent.thread_id = json_extract(t.payload_json, '$.lineage.parentThreadId')
            AND (
              json_extract(parent.payload_json, '$.settledOverride') = 'settled'
              OR json_extract(parent.payload_json, '$.archivedAt') IS NOT NULL
              OR parent.deleted_at IS NOT NULL
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runtime_requests request
          WHERE request.thread_id = t.thread_id AND request.status = 'pending'
        )
      ORDER BY t.thread_id
    `;
    for (const row of rows) {
      const provider = withLimits.find(
        (candidate) => candidate.instanceId === row.provider_instance_id,
      );
      const roomAt = provider === undefined ? null : usageRoomCheckedAt(provider, row.model ?? "");
      if (roomAt === null || roomAt <= Date.parse(row.failed_at)) continue;
      const threadId = ThreadId.make(row.thread_id);
      const repeated = yield* threads.getThreadRecords(threadId, ["runs"]).pipe(
        Effect.map(({ runs }) => limitRetryStreak(runs) > 0),
        Effect.orElseSucceed(() => true),
      );
      if (repeated) continue;
      yield* continueThread(threads, {
        threadId,
        commandId: CommandId.make(
          `${ROOM_CONTINUATION_COMMAND_PREFIX}${row.thread_id}:${row.run_id}`,
        ),
        createdBy: "agent",
        creationSource: "server",
      }).pipe(
        Effect.tap(() =>
          Effect.logInfo("orchestration-v2.limit-room.continued", {
            threadId,
            runId: row.run_id,
            providerInstanceId: row.provider_instance_id,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-room.continue-failed", { threadId, cause }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const release = yield* makeRelease;
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const probedAt = new Map<string, string>();
    yield* forkParked(
      Stream.runForEach(
        Stream.concat(Stream.fromEffect(registry.getProviders), registry.streamChanges),
        (providers) => {
          const probed = providers.filter((provider) => {
            const checkedAt = provider.usageLimits?.checkedAt;
            if (checkedAt === undefined || probedAt.get(provider.instanceId) === checkedAt)
              return false;
            probedAt.set(provider.instanceId, checkedAt);
            return true;
          });
          return release(probed).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.limit-room.sweep-failed", { cause }),
            ),
          );
        },
      ),
    );
  }),
);
