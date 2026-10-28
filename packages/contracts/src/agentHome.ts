import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AGENT_HOME_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const AgentHandle = TrimmedNonEmptyString.check(Schema.isPattern(AGENT_HOME_HANDLE_PATTERN));
export type AgentHandle = typeof AgentHandle.Type;

export const AgentHomeBinding = Schema.Struct({
  threadId: ThreadId,
  environmentId: Schema.NullOr(EnvironmentId),
  host: Schema.NullOr(Schema.String),
  at: Schema.NullOr(Schema.String),
  by: Schema.NullOr(Schema.String),
});
export type AgentHomeBinding = typeof AgentHomeBinding.Type;

export const AgentHome = Schema.Struct({
  handle: AgentHandle,
  workspaceRoot: TrimmedNonEmptyString,
  displayName: Schema.NullOr(Schema.String),
  role: Schema.NullOr(Schema.String),
  binding: Schema.NullOr(AgentHomeBinding),
  previous: Schema.NullOr(AgentHomeBinding),
});
export type AgentHome = typeof AgentHome.Type;

export const AgentHomesSnapshot = Schema.Struct({
  homes: Schema.Array(AgentHome),
});
export type AgentHomesSnapshot = typeof AgentHomesSnapshot.Type;

export const AgentBindInput = Schema.Struct({
  handle: AgentHandle,
  threadId: ThreadId,
  threadEnvironmentId: Schema.optional(EnvironmentId),
  host: Schema.optional(TrimmedNonEmptyString),
  by: Schema.optional(TrimmedNonEmptyString),
  onlyIfUnbound: Schema.optional(Schema.Boolean),
});
export type AgentBindInput = typeof AgentBindInput.Type;

export const AgentBindResult = Schema.Struct({
  home: AgentHome,
  changed: Schema.Boolean,
});
export type AgentBindResult = typeof AgentBindResult.Type;

export class AgentHomeError extends Schema.TaggedError<AgentHomeError>()("AgentHomeError", {
  message: Schema.String,
  handle: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}
