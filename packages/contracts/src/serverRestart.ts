import * as Schema from "effect/Schema";
import {
  ThreadId,
  RunId,
  RuntimeRequestId,
  NodeId,
  MessageId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const ServerRestartHandoff = Schema.Struct({
  threadId: ThreadId,
  runIds: Schema.Array(RunId),
  sourceRunIds: Schema.optional(Schema.Array(RunId)),
  queuedRunIds: Schema.Array(RunId),
  requestIds: Schema.Array(RuntimeRequestId),
  delegatedTaskIds: Schema.Array(NodeId),
  pausedRunIds: Schema.optional(Schema.Array(RunId)),
  paused: Schema.Boolean,
});
export type ServerRestartHandoff = typeof ServerRestartHandoff.Type;

const SERVER_RESTART_MAX_DRAIN_MS = 30 * 60 * 1000;

export const ServerPrepareRestartInput = Schema.Struct({
  epoch: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  drainTimeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: SERVER_RESTART_MAX_DRAIN_MS })),
  ),
});
export type ServerPrepareRestartInput = typeof ServerPrepareRestartInput.Type;

export const ServerRestartDrain = Schema.Struct({
  drained: Schema.Boolean,
  waitedMs: Schema.Number,
  activeRunIds: Schema.Array(RunId),
});
export type ServerRestartDrain = typeof ServerRestartDrain.Type;

export const ServerPrepareRestartResult = Schema.Struct({
  epoch: Schema.String,
  ready: Schema.Literal(true),
  threads: Schema.Array(ServerRestartHandoff),
  drain: Schema.optional(ServerRestartDrain),
});
export type ServerPrepareRestartResult = typeof ServerPrepareRestartResult.Type;

export class ServerPrepareRestartError extends Schema.TaggedError<ServerPrepareRestartError>()(
  "ServerPrepareRestartError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Server restart handoff preparation failed.";
  }
}

export const ServerAbortRestartResult = Schema.Struct({
  epoch: Schema.String,
  aborted: Schema.Literal(true),
});

export const ServerRestartStatus = Schema.Struct({
  epoch: Schema.String,
  threads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      sources: Schema.Array(
        Schema.Struct({
          sourceRunId: RunId,
          state: Schema.Literals(["pending", "continued", "completed", "paused", "stopped"]),
          continuationRunId: Schema.optional(RunId),
          intentPreserved: Schema.optional(Schema.Boolean),
          reason: Schema.optional(Schema.String),
          requestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
        }),
      ),
      queues: Schema.Array(
        Schema.Struct({
          runId: RunId,
          messageId: MessageId,
          state: Schema.String,
          deliveryRunId: Schema.NullOr(RunId),
        }),
      ),
    }),
  ),
});
export type ServerRestartStatus = typeof ServerRestartStatus.Type;
