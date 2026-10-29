import * as Schema from "effect/Schema";

import { CommandId, MessageId, NodeId, NonNegativeInt, RunId, ThreadId } from "./baseSchemas.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";
import {
  OrchestratorMcpClientRequestId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpPrompt,
} from "./orchestratorMcp.ts";

export const OrchestratorMcpThreadSendInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: ThreadId,
  message: OrchestratorMcpPrompt,
  mode: Schema.optional(Schema.Literals(["auto", "queue", "steer", "restart"])),
  clientRequestId: Schema.optional(
    OrchestratorMcpClientRequestId.annotate({
      description:
        "Reuse it to retry this exact send after a timeout: the message is delivered once and a retry returns the same receipt. A key belongs to one thread: reusing it for another message or mode there is refused.",
    }),
  ),
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
  runId: RunId,
  taskId: Schema.optional(NodeId),
  status: OrchestrationV2RunStatus,
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  receipt: Schema.optional(OrchestratorMcpThreadSendReceipt),
});
export type OrchestratorMcpThreadSendResult = typeof OrchestratorMcpThreadSendResult.Type;
