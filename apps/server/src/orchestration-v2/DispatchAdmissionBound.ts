import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

const BOUND_MS = 10_000;
export const BUSY_RETRY_AFTER_MS = 2_000;

export const DispatchAdmissionBound = Context.Reference<number | undefined>(
  "t3/orchestration-v2/DispatchAdmissionBound",
  { defaultValue: () => undefined },
);

export const boundDispatchAdmission = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, DispatchAdmissionBound, BOUND_MS);
