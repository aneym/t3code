import * as Schema from "effect/Schema";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
export const ServerSelfUpdateOutcome = Schema.Struct({
  id: TrimmedNonEmptyString,
  fromVersion: TrimmedNonEmptyString,
  targetVersion: TrimmedNonEmptyString,
  status: Schema.Literals(["committed", "rolled-back", "failed"]),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ServerSelfUpdateOutcome = typeof ServerSelfUpdateOutcome.Type;

export const ServerLifecycleReadyPayload = Schema.Struct({
  at: IsoDateTime,
  environment: ExecutionEnvironmentDescriptor,
  updateOutcome: Schema.optionalKey(ServerSelfUpdateOutcome),
});
export type ServerLifecycleReadyPayload = typeof ServerLifecycleReadyPayload.Type;

export const ServerLifecycleWelcomePayload = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapStatus: Schema.optional(Schema.Literals(["pending", "complete"])),
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
  bootstrapProjectCreated: Schema.optional(Schema.Boolean),
  bootstrapThreadCreated: Schema.optional(Schema.Boolean),
});
export type ServerLifecycleWelcomePayload = typeof ServerLifecycleWelcomePayload.Type;

export const ServerLifecycleLegacyThreadMigrationPayload = Schema.Struct({
  status: Schema.Union([Schema.Literal("running"), Schema.Literal("complete")]),
  totalThreadCount: NonNegativeInt,
});
export type ServerLifecycleLegacyThreadMigrationPayload =
  typeof ServerLifecycleLegacyThreadMigrationPayload.Type;

export const ServerLifecycleStreamWelcomeEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("welcome"),
  payload: ServerLifecycleWelcomePayload,
});
export type ServerLifecycleStreamWelcomeEvent = typeof ServerLifecycleStreamWelcomeEvent.Type;

export const ServerLifecycleStreamReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("ready"),
  payload: ServerLifecycleReadyPayload,
});
export type ServerLifecycleStreamReadyEvent = typeof ServerLifecycleStreamReadyEvent.Type;

export const ServerLifecycleStreamLegacyThreadMigrationEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("legacyThreadMigration"),
  payload: ServerLifecycleLegacyThreadMigrationPayload,
});
export type ServerLifecycleStreamLegacyThreadMigrationEvent =
  typeof ServerLifecycleStreamLegacyThreadMigrationEvent.Type;

export const ServerLifecycleStreamHandoffEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("handoff"),
  payload: Schema.Struct({ reconnectWithinMs: NonNegativeInt }),
});
export type ServerLifecycleStreamHandoffEvent = typeof ServerLifecycleStreamHandoffEvent.Type;

export const ServerLifecycleStreamEvent = Schema.Union([
  ServerLifecycleStreamHandoffEvent,
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleStreamReadyEvent,
  ServerLifecycleStreamLegacyThreadMigrationEvent,
]);
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;

export const ServerHandoffProbe = Schema.Struct({
  handoffClientId: Schema.optionalKey(TrimmedNonEmptyString),
  handoffSequence: Schema.optionalKey(NonNegativeInt),
});
export const ServerHandoffSubscription = Schema.Struct({
  handoffClientId: Schema.optionalKey(TrimmedNonEmptyString),
});
