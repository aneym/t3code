import * as Schema from "effect/Schema";
import { MessageId, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

export const OrchestrationV2DispatchCommandResult = Schema.Struct({
  sequence: NonNegativeInt,
  replayed: Schema.optional(Schema.Boolean),
  messageId: Schema.optional(MessageId),
});
export type OrchestrationV2DispatchCommandResult = typeof OrchestrationV2DispatchCommandResult.Type;

export const OrchestrationV2GetThreadProjectionInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationV2GetThreadProjectionInput =
  typeof OrchestrationV2GetThreadProjectionInput.Type;
