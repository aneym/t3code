import * as Schema from "effect/Schema";
import {
  ContextTransferId,
  EnvironmentId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "./baseSchemas.ts";
import { ProviderOptionSelection } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderRequestKind } from "./providerPolicy.ts";
import { AgentPlacementReceipt } from "./agentPlacement.ts";
import { OrchestratorMcpExecutedModel } from "./orchestratorMcpThreadRun.ts";
const OrchestratorMcpDelegatedTaskStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const OrchestratorMcpTerminalDelegatedTaskStatus = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const OrchestratorMcpRunningTaskNext = Schema.Literal(
  "Completion wakes this thread, so end your turn. Do not wait on it or poll it.",
);
export const OrchestratorMcpDelegateTaskResult = Schema.Struct({
  placement: Schema.optional(AgentPlacementReceipt),
  taskId: NodeId,
  /** Null for a task that runs in a linked environment; see `remoteChild`. */
  childThreadId: Schema.NullOr(ThreadId),
  /** The linked environment and thread a remote task runs as. */
  remoteChild: Schema.optional(
    Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId, label: Schema.String }),
  ),
  link: Schema.optional(Schema.String),
  childRunId: Schema.NullOr(RunId),
  childNodeId: NodeId,
  status: OrchestratorMcpDelegatedTaskStatus,
  workState: Schema.Literals(["working", "waiting_for_children", "result_available"]),
  hasPendingChildRuns: Schema.Boolean,
  latestTerminalRunId: Schema.NullOr(RunId),
  latestTerminalStatus: Schema.NullOr(OrchestratorMcpTerminalDelegatedTaskStatus),
  latestTerminalSummary: Schema.NullOr(Schema.String),
  latestTerminalResultContextTransferId: Schema.NullOr(ContextTransferId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.NullOr(Schema.String),
  executedModel: Schema.optional(OrchestratorMcpExecutedModel),
  options: Schema.optional(Schema.Array(ProviderOptionSelection)),
  summary: Schema.NullOr(Schema.String),
  resultContextTransferId: Schema.NullOr(ContextTransferId),
  hasPendingQuestion: Schema.Boolean.annotate({
    description:
      "A question blocks the child and ends a wait. Answer via `t3_pending_request` on `childThreadId`, or the user does.",
  }),
  pendingApproval: Schema.NullOr(
    Schema.Struct({ requestId: RuntimeRequestId, kind: ProviderRequestKind, runId: RunId }),
  ).annotate({
    description: "Oldest pending approval, or null. Ends a wait. Grants no approval rights.",
  }),
  waitTimedOut: Schema.Boolean.annotate({
    description: "True only on the timed-out wait call. The child keeps running.",
  }),
  next: Schema.optional(OrchestratorMcpRunningTaskNext),
});
export type OrchestratorMcpDelegateTaskResult = typeof OrchestratorMcpDelegateTaskResult.Type;
