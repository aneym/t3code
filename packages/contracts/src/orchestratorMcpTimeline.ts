import * as Schema from "effect/Schema";
import { ChatAttachmentId } from "./chatAttachment.ts";
import { MessageSender } from "./messageSender.ts";
import { QuietNoteFields } from "./threadNote.ts";
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
  ...QuietNoteFields,
  type: Schema.String,
  status: OrchestrationV2TurnItemStatus,
  title: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  textTruncated: Schema.Boolean,
  nextTextOffset: Schema.optional(Schema.NullOr(NonNegativeInt)),
  streaming: Schema.optional(
    Schema.Literal(true).annotate({
      description: "A reply still being written: `text` is partial and grows.",
    }),
  ),
  attachments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: ChatAttachmentId,
        type: Schema.String,
        name: Schema.String,
        mimeType: Schema.String,
      }),
    ),
  ),
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadTimelineItem = typeof OrchestratorMcpThreadTimelineItem.Type;
