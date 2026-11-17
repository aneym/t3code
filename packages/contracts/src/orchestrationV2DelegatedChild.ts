import * as Schema from "effect/Schema";
import { EnvironmentId, IsoDateTime, NodeId, ThreadId } from "./baseSchemas.ts";

export const OrchestrationV2DelegatedFrom = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: Schema.String,
  taskId: Schema.optional(NodeId),
});
export type OrchestrationV2DelegatedFrom = typeof OrchestrationV2DelegatedFrom.Type;

export const OrchestrationV2TaskCancel = Schema.Struct({
  taskId: NodeId,
  parentThreadId: ThreadId,
  parentTitle: Schema.String,
  parentEnvironmentId: Schema.optional(EnvironmentId),
  cancelledAt: IsoDateTime,
  reason: Schema.optional(Schema.String),
});
export type OrchestrationV2TaskCancel = typeof OrchestrationV2TaskCancel.Type;

export const OrchestrationV2DelegatedChildFields = {
  delegatedFrom: Schema.optional(OrchestrationV2DelegatedFrom),
  taskCancel: Schema.optional(Schema.NullOr(OrchestrationV2TaskCancel)),
  firstTaskCancel: Schema.optional(OrchestrationV2TaskCancel),
};

export const OrchestratorMcpDelegatedChildFields = {
  delegatedFrom: Schema.optional(OrchestrationV2DelegatedFrom),
  taskCancel: Schema.optional(OrchestrationV2TaskCancel),
  firstTaskCancel: Schema.optional(OrchestrationV2TaskCancel),
};
