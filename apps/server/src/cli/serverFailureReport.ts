import { redactCauseCredentials } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as CliError from "effect/cli/CliError";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Formatter from "effect/Formatter";
import * as Runtime from "effect/Runtime";

import { refusePortInUse } from "./portInUseRefusal.ts";

const MAX_REASON_LENGTH = 1_000;
const MAX_CAUSE_DEPTH = 4;

function describe(error: unknown, depth: number): string {
  if (!(error instanceof Error)) return Formatter.format(error);
  const message = error.message.trim();
  const own = message.length > 0 ? `${error.name}: ${message}` : error.name;
  if (error.cause === undefined || depth >= MAX_CAUSE_DEPTH) return own;
  const inner = describe(error.cause, depth + 1);
  return message.includes(inner) ? own : `${own} (${inner})`;
}

function serverFailureReason(cause: Cause.Cause<unknown>): string {
  const reason = describe(Cause.squash(redactCauseCredentials(cause)), 0)
    .replace(/\s+/g, " ")
    .trim();
  return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH - 1)}…` : reason;
}

function isReportedHere(cause: Cause.Cause<unknown>): boolean {
  if (Cause.hasInterruptsOnly(cause)) return false;
  const error = Cause.squash(cause);
  return !CliError.isCliError(error) && Runtime.getErrorReported(error);
}

export const reportServerFailureToStderr = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.tapCause(refusePortInUse(effect), (cause) =>
    isReportedHere(cause)
      ? Console.error(`T3 Code server failed: ${serverFailureReason(cause)}`)
      : Effect.void,
  );
