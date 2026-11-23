import { CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Settings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { unboundDispatchAdmission } from "./DispatchAdmissionBound.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const STARTING_RUN_GRACE = Duration.seconds(15);
const TICK = Duration.seconds(5);
const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(EffectOutbox.OrchestrationEffectRequestV2),
);

interface Tracked {
  readonly threadId: ThreadId;
  since: number;
  restarted: boolean;
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const settings = yield* Settings.ServerSettingsService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const events = yield* EventSink.EventSinkV2;
    const tracked = new Map<RunId, Tracked>();

    const track = (threadId: ThreadId, runId: RunId, since: number) => {
      if (!tracked.has(runId)) tracked.set(runId, { threadId, since, restarted: false });
    };

    const hasLiveEffect = (threadId: ThreadId) =>
      sql<{ readonly found: number }>`
        SELECT 1 AS found FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId} AND status IN ('pending', 'running')
        LIMIT 1
      `.pipe(Effect.map((rows) => rows.length > 0));

    const failedRestart = (threadId: ThreadId, runId: RunId) =>
      sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId} AND effect_type = 'provider-turn.restart'
          AND status = 'failed' AND json_extract(payload_json, '$.runId') = ${runId}
        ORDER BY rowid DESC
        LIMIT 1
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.undefined : decodeRequest(rows[0].payload_json),
        ),
      );

    const restartStart = Effect.fn("StartingRunSupervisor.restartStart")(function* (
      runId: RunId,
      entry: Tracked,
      now: number,
    ) {
      const commandId = CommandId.make(`command:starting-run-recovery:${runId}:${now}`);
      const request = (yield* failedRestart(entry.threadId, runId)) ?? {
        type: "provider-turn.start" as const,
        runId,
      };
      yield* Effect.logWarning("orchestration-v2.starting-run.restart", {
        threadId: entry.threadId,
        runId,
        effectType: request.type,
      });
      yield* events.writeWithEffects({
        commandId,
        events: [],
        effects: [
          {
            id: `effect:${commandId}:${request.type}:${runId}`,
            commandId,
            threadId: entry.threadId,
            request,
          },
        ],
      });
    });

    const stop = Effect.fn("StartingRunSupervisor.stop")(function* (runId: RunId, entry: Tracked) {
      yield* Effect.logWarning("orchestration-v2.starting-run.stop", {
        threadId: entry.threadId,
        runId,
      });
      yield* threads
        .dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`command:starting-run-stop:${runId}`),
          threadId: entry.threadId,
          runId,
          reason: "Closed a run that stayed starting with nothing left to start it.",
        })
        .pipe(unboundDispatchAdmission);
    });

    const inspect = Effect.fn("StartingRunSupervisor.inspect")(function* (
      runId: RunId,
      entry: Tracked,
      now: number,
    ) {
      const { runs } = yield* threads.getThreadRecords(entry.threadId, ["runs"]);
      const run = runs.find((candidate) => candidate.id === runId);
      if (run === undefined || run.status !== "starting") {
        tracked.delete(runId);
        return;
      }
      if (yield* hasLiveEffect(entry.threadId)) {
        entry.since = now;
        return;
      }
      if (now - entry.since < Duration.toMillis(STARTING_RUN_GRACE)) return;
      entry.since = now;
      if (!entry.restarted) {
        entry.restarted = true;
        return yield* restartStart(runId, entry, now);
      }
      tracked.delete(runId);
      return yield* stop(runId, entry);
    });

    const sweep = Effect.gen(function* () {
      if (!(yield* settings.getSettings).startingRunRecovery) return;
      const now = yield* Clock.currentTimeMillis;
      for (const [runId, entry] of tracked) {
        yield* inspect(runId, entry, now).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.starting-run.inspect-failed", { runId, cause }),
          ),
        );
      }
    });

    const afterSequence = yield* events.latestSequence();
    const startedAt = yield* Clock.currentTimeMillis;
    const recovered = yield* sql<{ readonly run_id: string; readonly thread_id: string }>`
      SELECT run_id, thread_id FROM orchestration_v2_projection_runs WHERE status = 'starting'
    `;
    for (const row of recovered) {
      track(ThreadId.make(row.thread_id), RunId.make(row.run_id), startedAt);
    }

    const observe = (eventType: "run.created" | "run.updated") =>
      events.stream({ afterSequence, eventType }).pipe(
        Stream.runForEach((stored) =>
          Effect.gen(function* () {
            const event = stored.event;
            if (event.type !== "run.created" && event.type !== "run.updated") return;
            if (event.payload.status !== "starting") {
              tracked.delete(event.payload.id);
              return;
            }
            track(event.threadId, event.payload.id, yield* Clock.currentTimeMillis);
          }),
        ),
      );

    yield* forkParked(observe("run.created"));
    yield* forkParked(observe("run.updated"));
    yield* forkParked(
      Effect.forever(
        Effect.sleep(TICK).pipe(
          Effect.andThen(sweep),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.starting-run.sweep-failed", { cause }),
          ),
        ),
      ),
    );
  }),
);
