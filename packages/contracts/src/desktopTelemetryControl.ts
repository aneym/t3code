import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DesktopUpdateChannelSchema } from "./ipc.ts";

export const DesktopTelemetrySetDiagnosticsDemand = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("setDiagnosticsDemand"),
  enabled: Schema.Boolean,
});
export type DesktopTelemetrySetDiagnosticsDemand = typeof DesktopTelemetrySetDiagnosticsDemand.Type;

export const DesktopTelemetrySetHostPowerIntervals = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("setHostPowerIntervals"),
  activeIntervalMs: PositiveInt,
  idleIntervalMs: PositiveInt,
});
export type DesktopTelemetrySetHostPowerIntervals =
  typeof DesktopTelemetrySetHostPowerIntervals.Type;

/** Runs check/download/quit-and-install without local confirmation; the remote RPC click supplies consent. */
export const DesktopTelemetryRequestDesktopUpdate = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("requestDesktopUpdate"),
  requestId: TrimmedNonEmptyString,
  /** A track switch: move to this channel first, and install only `targetVersion`. */
  channel: Schema.optionalKey(DesktopUpdateChannelSchema),
  targetVersion: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DesktopTelemetryRequestDesktopUpdate = typeof DesktopTelemetryRequestDesktopUpdate.Type;

export const DesktopTelemetryCommitDesktopUpdate = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("commitDesktopUpdate"),
  requestId: TrimmedNonEmptyString,
});
export type DesktopTelemetryCommitDesktopUpdate = typeof DesktopTelemetryCommitDesktopUpdate.Type;

export const DesktopTelemetryCancelDesktopUpdate = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("cancelDesktopUpdate"),
  requestId: TrimmedNonEmptyString,
});
export type DesktopTelemetryCancelDesktopUpdate = typeof DesktopTelemetryCancelDesktopUpdate.Type;

export const DesktopTelemetryControlMessage = Schema.Union([
  DesktopTelemetrySetDiagnosticsDemand,
  DesktopTelemetrySetHostPowerIntervals,
  DesktopTelemetryRequestDesktopUpdate,
  DesktopTelemetryCommitDesktopUpdate,
  DesktopTelemetryCancelDesktopUpdate,
]);
export type DesktopTelemetryControlMessage = typeof DesktopTelemetryControlMessage.Type;
