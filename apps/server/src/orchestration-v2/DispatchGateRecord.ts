import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Schedule from "effect/Schedule";

import { makeDispatchGateLog } from "../observability/DispatchGateLog.ts";
import * as Metrics from "../observability/Metrics.ts";
import { noteDispatchGate } from "../observability/RequestLog.ts";

export type GatePhase = "decide" | "commit" | "publish" | "after";

export interface GateLabel {
  readonly type: string;
  readonly thread?: string;
}

interface Waiter {
  readonly label: GateLabel;
  readonly since: number;
}

interface Holder {
  readonly label: GateLabel;
  readonly waitMs: number;
  readonly acquiredAt: number;
  readonly phaseMs: Partial<Record<GatePhase, number>>;
  phase: GatePhase | undefined;
  phaseAt: number;
  stuckAt: number | undefined;
}

const SLOW_MS = 1_000;
const STUCK_MS = 5_000;
const SWEEP_EVERY = "1 second";

const CurrentGateHolders = Context.Reference<ReadonlyArray<Holder>>(
  "t3/orchestration-v2/DispatchGateRecord/CurrentGateHolders",
  { defaultValue: () => [] },
);

const closePhase = (holder: Holder, now: number) => {
  if (holder.phase === undefined) return;
  holder.phaseMs[holder.phase] = (holder.phaseMs[holder.phase] ?? 0) + now - holder.phaseAt;
};

export const markGatePhase = (phase: GatePhase) =>
  Effect.flatMap(Effect.service(CurrentGateHolders), (holders) =>
    holders.length === 0
      ? Effect.void
      : Effect.map(Clock.currentTimeMillis, (now) => {
          for (const holder of holders) {
            closePhase(holder, now);
            holder.phase = phase;
            holder.phaseAt = now;
          }
        }),
  );

const holderFields = (holder: Holder) => ({
  type: holder.label.type,
  ...(holder.label.thread === undefined ? {} : { thread: holder.label.thread }),
});

export const makeGateRecorder = Effect.gen(function* () {
  const write = yield* makeDispatchGateLog;
  const waiters = new Set<Waiter>();
  const holders = new Set<Holder>();

  const sweep = Effect.map(Clock.currentTimeMillis, (now) => {
    let oldest: Waiter | undefined;
    for (const waiter of waiters)
      if (oldest === undefined || waiter.since < oldest.since) oldest = waiter;
    if (oldest === undefined || now - oldest.since < STUCK_MS) return;
    for (const holder of holders) {
      if (holder.stuckAt !== undefined && now - holder.stuckAt < STUCK_MS) continue;
      holder.stuckAt = now;
      write({
        k: "stuck",
        ...holderFields(holder),
        phase: holder.phase ?? "-",
        holdMs: now - holder.acquiredAt,
        waiter: oldest.label.type,
        waitMs: now - oldest.since,
        waiters: waiters.size,
      });
    }
  });
  yield* sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_EVERY)), Effect.forkScoped);

  const release = (holder: Holder, outermost: boolean) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      holders.delete(holder);
      closePhase(holder, now);
      const holdMs = now - holder.acquiredAt;
      if (holder.waitMs >= SLOW_MS || holdMs >= SLOW_MS)
        write({
          k: "hold",
          ...holderFields(holder),
          waitMs: holder.waitMs,
          holdMs,
          phaseMs: holder.phaseMs,
          waiters: waiters.size,
        });
      const attributes = Metrics.metricAttributes({ type: holder.label.type });
      return Effect.all([
        Metric.update(
          Metric.withAttributes(Metrics.dispatchGateWait, attributes),
          Duration.millis(holder.waitMs),
        ),
        Metric.update(
          Metric.withAttributes(Metrics.dispatchGateHold, attributes),
          Duration.millis(holdMs),
        ),
        outermost ? noteDispatchGate(holder.waitMs, holdMs) : Effect.void,
      ]);
    });

  const record =
    (base: GateLabel, lock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.flatMap(
        Effect.zip(Clock.currentTimeMillis, Effect.service(CurrentGateHolders)),
        ([since, outer]) => {
          const parent = outer.at(-1)?.label;
          const label: GateLabel =
            parent === undefined ? base : { ...parent, type: `${parent.type}:${base.type}` };
          const waiter: Waiter = { label, since };
          waiters.add(waiter);
          const held = Effect.flatMap(Clock.currentTimeMillis, (acquiredAt) => {
            waiters.delete(waiter);
            const holder: Holder = {
              label,
              waitMs: acquiredAt - since,
              acquiredAt,
              phaseMs: {},
              phase: undefined,
              phaseAt: acquiredAt,
              stuckAt: undefined,
            };
            holders.add(holder);
            return effect.pipe(
              Effect.provideService(CurrentGateHolders, [...outer, holder]),
              Effect.ensuring(release(holder, parent === undefined)),
            );
          });
          return lock(held).pipe(Effect.ensuring(Effect.sync(() => waiters.delete(waiter))));
        },
      );

  return { record };
});
