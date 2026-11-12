import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import { cliRefusal } from "../cliRefusal.ts";

export class PortInUseError extends Schema.TaggedError<PortInUseError>()("PortInUseError", {
  address: Schema.String,
  port: Schema.Number,
}) {
  override readonly [Runtime.errorReported] = false;
  readonly [cliRefusal] = true;

  override get message(): string {
    const where = this.address.length > 0 ? ` on ${this.address}` : "";
    return `Port ${this.port}${where} is in use by another program. Stop that program, or pass --port to choose another port.`;
  }
}

const findAddressInUse = (error: unknown, depth = 0): PortInUseError | undefined => {
  if (typeof error !== "object" || error === null || depth > 4) return undefined;
  const { code, address, port, cause } = error as {
    code?: unknown;
    address?: unknown;
    port?: unknown;
    cause?: unknown;
  };
  if (code === "EADDRINUSE" && typeof port === "number") {
    return new PortInUseError({ address: typeof address === "string" ? address : "", port });
  }
  return findAddressInUse(cause, depth + 1);
};

export const refusePortInUse = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PortInUseError, R> =>
  Effect.catchCause(effect, (cause) => {
    const inUse = Cause.hasInterruptsOnly(cause)
      ? undefined
      : findAddressInUse(Cause.squash(cause));
    return Effect.failCause<E | PortInUseError>(inUse === undefined ? cause : Cause.fail(inUse));
  });
