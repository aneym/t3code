import { CommandId, RunId, ThreadId, type OrchestrationV2Run } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { forkParked } from "../serverActivation.ts";
import * as DelegatedChildStartGate from "./DelegatedChildStartGate.ts";
import { unboundDispatchAdmission } from "./DispatchAdmissionBound.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const DEADLINE_MINUTES = 10;
export const PREPARATION_ADOPT_AFTER = Duration.seconds(5);
export const PREPARATION_DEADLINE = Duration.minutes(DEADLINE_MINUTES);
const TICK = Duration.seconds(5);

interface Tracked {
  readonly threadId: ThreadId;
  since: number;
}

const preparing = (
  run: Pick<OrchestrationV2Run, "status" | "workspacePreparation" | "childStartHeld">,
) =>
  run.status === "preparing" &&
  (run.workspacePreparation !== undefined || run.childStartHeld === true);

const deadlineMessage = (queued: number) =>
  `Workspace setup did not finish within ${DEADLINE_MINUTES} minutes, so the agent never started on this message.` +
  (queued === 0
    ? ""
    : ` The ${queued === 1 ? "message" : `${queued} messages`} queued behind it ${queued === 1 ? "starts" : "start"} next.`);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const events = yield* EventSink.EventSinkV2;
    const gate = yield* DelegatedChildStartGate.DelegatedChildStartGate;
    const tracked = new Map<RunId, Tracked>();

    const track = (threadId: ThreadId, runId: RunId, since: number) => {
      if (!tracked.has(runId)) tracked.set(runId, { threadId, since });
    };

    const failAtDeadline = Effect.fn("PreparingRunSupervisor.failAtDeadline")(function* (
      runId: RunId,
      entry: Tracked,
      runs: ReadonlyArray<OrchestrationV2Run>,
      reason?: string,
    ) {
      const message =
        reason ?? deadlineMessage(runs.filter((run) => run.status === "queued").length);
      yield* Effect.logWarning("orchestration-v2.preparing-run.deadline", {
        threadId: entry.threadId,
        runId,
      });
      yield* threads
        .dispatch({
          type: "prepared-run.fail",
          commandId: CommandId.make(`command:preparation-deadline:${runId}`),
          threadId: entry.threadId,
          runId,
          failure: makeProviderFailure({
            message,
            class: "validation_error",
            retryable: true,
          }),
        })
        .pipe(unboundDispatchAdmission);
    });

    const inspect = Effect.fn("PreparingRunSupervisor.inspect")(function* (
      runId: RunId,
      entry: Tracked,
      now: number,
    ) {
      const { runs } = yield* threads.getThreadRecords(entry.threadId, ["runs"]);
      const run = runs.find((candidate) => candidate.id === runId);
      if (run === undefined || !preparing(run)) {
        tracked.delete(runId);
        return;
      }
      if (gate.isHeld(run)) {
        entry.since = now;
        const expired = yield* gate.expired(runId, now);
        if (expired === undefined) return;
        tracked.delete(runId);
        return yield* failAtDeadline(runId, entry, runs, expired);
      }
      if (run.workspacePreparation === undefined) {
        tracked.delete(runId);
        return;
      }
      const age = now - entry.since;
      if (age >= Duration.toMillis(PREPARATION_DEADLINE)) {
        tracked.delete(runId);
        return yield* failAtDeadline(runId, entry, runs);
      }
      if (age < Duration.toMillis(PREPARATION_ADOPT_AFTER)) return;
      yield* launches.prepareRun({
        commandId: CommandId.make(`command:preparation-adopt:${runId}`),
        threadId: entry.threadId,
        runId,
      });
    });

    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const [runId, entry] of tracked) {
        yield* inspect(runId, entry, now).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.preparing-run.inspect-failed", { runId, cause }),
          ),
        );
      }
    });

    const afterSequence = yield* events.latestSequence();
    const startedAt = yield* Clock.currentTimeMillis;
    const recovered = yield* sql<{ readonly run_id: string; readonly thread_id: string }>`
      SELECT run_id, thread_id FROM orchestration_v2_projection_runs
      WHERE status = 'preparing'
        AND (json_extract(payload_json, '$.workspacePreparation') IS NOT NULL
          OR json_extract(payload_json, '$.childStartHeld') = 1)
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
            if (!preparing(event.payload)) {
              tracked.delete(event.payload.id);
              return;
            }
            track(event.threadId, event.payload.id, yield* Clock.currentTimeMillis);
          }),
        ),
      );

    yield* forkParked(observe("run.created"));
    yield* forkParked(observe("run.updated"));
    yield* forkParked(Effect.forever(Effect.sleep(TICK).pipe(Effect.andThen(sweep))));
  }),
);
