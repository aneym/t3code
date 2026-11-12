import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

export const cliRefusal = Symbol.for("@t3tools/server/cliRefusal");

interface CliRefusal {
  readonly [cliRefusal]: true;
  readonly message: string;
}

const isCliRefusal = (error: unknown): error is CliRefusal =>
  typeof error === "object" && error !== null && cliRefusal in error;

export const reportCliRefusals = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.tapCause(effect, (cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.void;
    const error = Cause.squash(cause);
    return isCliRefusal(error) ? Console.error(error.message) : Effect.void;
  });
