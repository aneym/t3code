import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, RunId, ThreadId } from "./baseSchemas.ts";

export const ServerDrainStatus = Schema.Struct({
  draining: Schema.Boolean,
  since: Schema.NullOr(IsoDateTime),
  activeRunIds: Schema.Array(RunId),
  waitingThreadIds: Schema.Array(ThreadId),
});
export type ServerDrainStatus = typeof ServerDrainStatus.Type;

export const ServerDrainWaitResult = Schema.Struct({
  ...ServerDrainStatus.fields,
  idle: Schema.Boolean,
  waitedMs: NonNegativeInt,
});
export type ServerDrainWaitResult = typeof ServerDrainWaitResult.Type;

export const ServerSetDrainInput = Schema.Struct({ draining: Schema.Boolean });
export type ServerSetDrainInput = typeof ServerSetDrainInput.Type;

export class ServerDrainError extends Schema.TaggedError<ServerDrainError>()("ServerDrainError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Server drain failed.";
  }
}
