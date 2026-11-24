import * as Schema from "effect/Schema";

import { CommandId, MessageId, NodeId, NonNegativeInt, RunId, ThreadId } from "./baseSchemas.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";
import { ThreadSendDelivery } from "./threadSendDelivery.ts";
import {
  OrchestratorMcpClientRequestId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpPrompt,
} from "./orchestratorMcp.ts";

export const OrchestratorMcpMessageContext = Schema.String.check(
  Schema.isMaxLength(16_000),
).annotate({
  description:
    "Agent-only background for `message`, kept out of the chat bubble, like a Rails desk block.",
});

export const OrchestratorMcpThreadSendInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: ThreadId,
  message: OrchestratorMcpPrompt,
  context: Schema.optional(OrchestratorMcpMessageContext),
  mode: Schema.optional(Schema.Literals(["auto", "queue", "steer", "restart", "note"])),
  freshContext: Schema.optional(
    Schema.Union([Schema.Boolean, Schema.Literal("carry")]).annotate({
      description:
        'Start a new provider session in the same thread. Never steers. `true`: no earlier context, like /clear. `"carry"`: the new session opens with a capped summary of the thread, its open child tasks and pending background work. `false`: keep the current session; a queued or auto send to an idle delegated child otherwise rolls it to a carried fresh session once its context grows large.',
    }),
  ),
  clientRequestId: Schema.optional(
    OrchestratorMcpClientRequestId.annotate({
      description:
        "Reuse it to retry this exact send after a timeout: the message is delivered once and a retry returns the same receipt. A key belongs to one thread: reusing it for another message or mode there is refused.",
    }),
  ),
  composerIds: Schema.optional(Schema.Struct({ commandId: CommandId, messageId: MessageId })),
});
export type OrchestratorMcpThreadSendInput = typeof OrchestratorMcpThreadSendInput.Type;

export const OrchestratorMcpThreadSendReceipt = Schema.Struct({
  commandId: CommandId,
  sequence: NonNegativeInt,
  replayed: Schema.Boolean.annotate({
    description: "True when this call matched a send that was already accepted.",
  }),
});
export type OrchestratorMcpThreadSendReceipt = typeof OrchestratorMcpThreadSendReceipt.Type;

export const OrchestratorMcpThreadSendResult = Schema.Struct({
  threadId: ThreadId,
  link: Schema.optional(Schema.String),
  messageId: MessageId,
  runId: Schema.optional(RunId),
  taskId: Schema.optional(NodeId),
  status: Schema.optional(OrchestrationV2RunStatus),
  ...ThreadSendDelivery.fields,
  rolled: Schema.optional(
    Schema.Literal(true).annotate({
      description:
        "This delegated child's context was large, so it started a fresh session carrying its brief and a summary. Same thread, worktree and task.",
    }),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  receipt: Schema.optional(OrchestratorMcpThreadSendReceipt),
});
export type OrchestratorMcpThreadSendResult = typeof OrchestratorMcpThreadSendResult.Type;
