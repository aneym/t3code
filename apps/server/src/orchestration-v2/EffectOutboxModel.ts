import {
  OrchestrationV2RunJson as OrchestrationV2Run,
  OrchestrationV2ConversationMessageJson as OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNodeJson as OrchestrationV2ExecutionNode,
  OrchestrationV2RunAttemptJson as OrchestrationV2RunAttempt,
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  ServerRestartHandoff,
  MessageId,
  NodeId,
  ProviderSessionId,
  RunAttemptId,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

export const OrchestrationEffectRequestV2 = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("queued-input.reconcile"),
    targetRunId: RunId,
    responseEffectIds: Schema.Array(Schema.String),
    requestIds: Schema.Array(RuntimeRequestId),
    members: Schema.Array(
      Schema.Struct({
        run: OrchestrationV2Run,
        message: OrchestrationV2ConversationMessage,
        node: Schema.NullOr(OrchestrationV2ExecutionNode),
        attempt: Schema.NullOr(OrchestrationV2RunAttempt),
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-runtime.restart-reapproval"),
    sourceRunIds: Schema.Array(RunId),
    text: Schema.String,
    epoch: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("provider-runtime.restart-handoff"),
    epoch: Schema.String,
    handoff: ServerRestartHandoff,
  }),
  Schema.Struct({
    type: Schema.Literal("provider-runtime.continue"),
    sourceRunId: RunId,
  }),
  Schema.Struct({
    type: Schema.Literal("provider-session.detach"),
    providerSessionId: ProviderSessionId,
    detail: Schema.optional(Schema.String),
    revokeMcpCredential: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-turn.start"),
    runId: RunId,
  }),
  Schema.Struct({
    type: Schema.Literal("provider-turn.interrupt"),
    providerSessionId: ProviderSessionId,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    subagent: Schema.optional(Schema.Struct({ id: NodeId, nativeTaskId: Schema.String })),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-turn.steer"),
    providerSessionId: ProviderSessionId,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    messageId: MessageId,
  }),
  Schema.Struct({
    type: Schema.Literal("provider-turn.restart"),
    providerSessionId: ProviderSessionId,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    interruptedAttemptId: RunAttemptId,
    runId: RunId,
    sessionTransition: Schema.optional(
      Schema.Union([
        Schema.Struct({
          type: Schema.Literal("replace"),
          replacementProviderSessionId: ProviderSessionId,
        }),
        Schema.Struct({ type: Schema.Literal("detach") }),
      ]),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("runtime-request.respond"),
    queuedInputDelivery: Schema.optional(Schema.Boolean),
    providerSessionId: ProviderSessionId,
    requestId: RuntimeRequestId,
    decision: Schema.optional(ProviderApprovalDecision),
    feedback: Schema.optional(Schema.String),
    answers: Schema.optional(ProviderUserInputAnswers),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-thread.rollback"),
    restoreFiles: Schema.optional(Schema.Boolean),
    providerThreadId: ProviderThreadId,
    checkpointId: CheckpointId,
    scopeId: CheckpointScopeId,
  }),
  Schema.Struct({
    type: Schema.Literal("checkpoint.capture"),
    runId: RunId,
    scopeId: CheckpointScopeId,
  }),
  Schema.Struct({
    type: Schema.Literal("scheduled-tasks.cleanup"),
  }),
  Schema.Struct({
    type: Schema.Literal("terminal.cleanup"),
  }),
  Schema.Struct({
    type: Schema.Literal("preview.cleanup"),
  }),
  Schema.Struct({
    type: Schema.Literal("attachment.cleanup"),
    attachmentIds: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("thread-title.generate"),
    kind: Schema.Union([
      Schema.Struct({ type: Schema.Literal("initial"), messageId: MessageId }),
      Schema.Struct({ type: Schema.Literal("regenerate") }),
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("delegated-tasks.stop"),
    reason: Schema.optional(Schema.String),
  }),
]);
export type OrchestrationEffectRequestV2 = typeof OrchestrationEffectRequestV2.Type;

export const REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS = [
  "queued-input.reconcile",
  "provider-runtime.restart-reapproval",
  "provider-runtime.restart-handoff",
  "provider-runtime.continue",
  "provider-session.detach",
  "provider-thread.rollback",
  "checkpoint.capture",
  "scheduled-tasks.cleanup",
  "terminal.cleanup",
  "preview.cleanup",
  "attachment.cleanup",
  "thread-title.generate",
  "delegated-tasks.stop",
] as const satisfies ReadonlyArray<OrchestrationEffectRequestV2["type"]>;

export const PROCESS_BOUND_EFFECT_TYPES = [
  "provider-turn.start",
  "provider-turn.interrupt",
  "provider-turn.steer",
  "provider-turn.restart",
  "runtime-request.respond",
] as const satisfies ReadonlyArray<OrchestrationEffectRequestV2["type"]>;

export const OrchestrationEffectStatusV2 = Schema.Literals([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type OrchestrationEffectStatusV2 = typeof OrchestrationEffectStatusV2.Type;

/** Receipts deduplicate retries, and restart re-enqueues need far less than a week. Retain failed rows to keep deleted-thread worktrees. */
export const SETTLED_EFFECT_RETENTION = Duration.days(7);

export interface OrchestrationEffectV2 {
  readonly id: string;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly request: OrchestrationEffectRequestV2;
  readonly status: OrchestrationEffectStatusV2;
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly leaseOwner: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly lastError: string | null;
}

export interface PendingOrchestrationEffectV2 {
  readonly id: string;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly request: OrchestrationEffectRequestV2;
  readonly availableAt?: DateTime.Utc;
}

export class EffectOutboxError extends Schema.TaggedError<EffectOutboxError>()(
  "EffectOutboxError",
  {
    operation: Schema.String,
    effectId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Orchestration effect outbox ${this.operation} failed${this.effectId === undefined ? "" : ` for ${this.effectId}`}.`;
  }
}

export const isEffectOutboxError = Schema.is(EffectOutboxError);
