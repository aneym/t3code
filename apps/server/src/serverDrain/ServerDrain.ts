import { RESTART_DRAIN_ENV, restartDrainSeconds } from "@t3tools/shared/restartDrain";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerLifecycleEvents } from "../serverLifecycleEvents.ts";
import { proceedStop, setStopDrainer } from "./stopSignal.ts";

const POLL_INTERVAL = Duration.seconds(1);
const ANNOUNCE_FLUSH = Duration.millis(250);

interface DrainState {
  readonly draining: boolean;
  readonly inFlight: number;
}

export class ServerDrain extends Context.Service<
  ServerDrain,
  {
    readonly draining: Effect.Effect<boolean>;
    readonly countTurnStart: <A, E, R>(start: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/serverDrain/ServerDrain") {}

export const layer = Layer.effect(
  ServerDrain,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lifecycleEvents = yield* ServerLifecycleEvents;
    const drainSeconds = restartDrainSeconds(
      Option.getOrUndefined(yield* Config.String(RESTART_DRAIN_ENV).pipe(Config.option)),
    );
    const state = yield* Ref.make<DrainState>({ draining: false, inFlight: 0 });
    const stopRequested = yield* Deferred.make<void>();

    const executingRuns = sql<{ readonly open: number }>`
      SELECT COUNT(*) AS open FROM orchestration_v2_projection_runs
      WHERE status IN ('starting', 'running')
    `.pipe(
      Effect.map((rows) => rows[0]?.open ?? 0),
      Effect.orElseSucceed(() => 0),
    );

    const openWork = Effect.gen(function* () {
      const { inFlight } = yield* Ref.get(state);
      return inFlight + (yield* executingRuns);
    });

    const drain = Effect.gen(function* () {
      yield* Ref.update(state, (current) => ({ ...current, draining: true }));
      const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
      const deadline = startedAt + drainSeconds * 1000;
      let open = yield* openWork;
      yield* Effect.logInfo("Server stop requested; finishing running turns first", {
        openRuns: open,
        drainSeconds,
      });
      while (open > 0 && DateTime.toEpochMillis(yield* DateTime.now) < deadline) {
        yield* Effect.sleep(POLL_INTERVAL);
        open = yield* openWork;
      }
      yield* Effect.logInfo("Server drain finished", {
        openRuns: open,
        waitedMs: DateTime.toEpochMillis(yield* DateTime.now) - startedAt,
      });
      yield* lifecycleEvents.publish({
        version: 1,
        type: "restarting",
        payload: { at: DateTime.formatIso(yield* DateTime.now) },
      });
      yield* Effect.sleep(ANNOUNCE_FLUSH);
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Server drain failed", { cause })),
      Effect.ensuring(Effect.sync(proceedStop)),
    );

    yield* Effect.acquireRelease(
      Effect.sync(() => setStopDrainer(() => Deferred.doneUnsafe(stopRequested, Effect.void))),
      () => Effect.sync(() => setStopDrainer(null)),
    );
    yield* Effect.forkScoped(Deferred.await(stopRequested).pipe(Effect.andThen(drain)));

    return ServerDrain.of({
      draining: Ref.get(state).pipe(Effect.map((current) => current.draining)),
      countTurnStart: Effect.fn("ServerDrain.countTurnStart")(function* <A, E, R>(
        start: Effect.Effect<A, E, R>,
      ) {
        yield* Ref.update(state, (current) => ({ ...current, inFlight: current.inFlight + 1 }));
        return yield* start.pipe(
          Effect.ensuring(
            Ref.update(state, (current) => ({ ...current, inFlight: current.inFlight - 1 })),
          ),
        );
      }),
    });
  }),
);
