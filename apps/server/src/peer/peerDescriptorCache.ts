import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";

const secondsKnob = (name: string, fallback: number) =>
  Config.Int(name).pipe(
    Effect.map((seconds) => Math.max(1, seconds) * 1000),
    Effect.orElseSucceed(() => fallback * 1000),
  );

const intervalMillis = secondsKnob("T3CODE_PEER_CHECK_INTERVAL_SECONDS", 30);
const maxIntervalMillis = secondsKnob("T3CODE_PEER_CHECK_MAX_INTERVAL_SECONDS", 120);

export const peerCheckSchedule = Effect.map(intervalMillis, (millis) =>
  Schedule.spaced(`${millis} millis`).pipe(Schedule.jittered),
);

interface Entry<A> {
  readonly value: A;
  readonly heldFor: number;
  readonly freshUntil: number;
}

export const makePeerDescriptorCache = Effect.fn("PeerDescriptorCache.make")(function* <
  A extends { readonly environmentId: string },
>() {
  const baseMs = yield* intervalMillis;
  const maxMs = Math.max(baseMs, yield* maxIntervalMillis);
  const entries = new Map<string, Entry<A>>();

  const cached =
    <E, R>(probe: (origin: string) => Effect.Effect<Option.Option<A>, E, R>) =>
    (origin: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const entry = entries.get(origin);
        if (entry !== undefined && now < entry.freshUntil) return Option.some(entry.value);
        const found = yield* probe(origin);
        if (Option.isNone(found)) {
          entries.delete(origin);
          return found;
        }
        const heldFor =
          entry === undefined || entry.value.environmentId !== found.value.environmentId
            ? baseMs
            : Math.min(entry.heldFor * 2, maxMs);
        const jitter = yield* Random.nextBetween(0.8, 1.2);
        entries.set(origin, { value: found.value, heldFor, freshUntil: now + heldFor * jitter });
        return found;
      });

  const forget = (environmentId: string) =>
    Effect.sync(() => {
      for (const [origin, entry] of entries) {
        if (entry.value.environmentId === environmentId) entries.delete(origin);
      }
    });

  return { cached, forget };
});
