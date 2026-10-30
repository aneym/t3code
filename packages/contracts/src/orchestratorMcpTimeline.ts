import * as Schema from "effect/Schema";
import { MessageSender } from "./messageSender.ts";
import {
  ThreadId,
  TurnItemId,
  NodeId,
  RunId,
  MessageId,
  NonNegativeInt,
  IsoDateTime,
} from "./baseSchemas.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2TurnItemStatus,
} from "./orchestrationV2.ts";

export const OrchestratorMcpThreadTimelineItem = Schema.Struct({
  position: NonNegativeInt,
  visibility: Schema.Literals(["local", "inherited", "synthetic"]),
  sourceThreadId: ThreadId,
  itemId: TurnItemId,
  subagentId: Schema.optional(NodeId),
  runId: Schema.NullOr(RunId),
  messageId: Schema.NullOr(MessageId),
  createdBy: Schema.NullOr(OrchestrationV2Actor),
  creationSource: Schema.NullOr(OrchestrationV2CreationSource),
  ...MessageSender.fields,
  type: Schema.String,
  status: OrchestrationV2TurnItemStatus,
  title: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  textTruncated: Schema.Boolean,
  nextTextOffset: Schema.optional(Schema.NullOr(NonNegativeInt)),
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadTimelineItem = typeof OrchestratorMcpThreadTimelineItem.Type;
