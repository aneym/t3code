import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId } from "./baseSchemas.ts";

export const MessageSender = Schema.Struct({
  senderThreadId: Schema.optional(ThreadId),
  senderEnvironmentId: Schema.optional(EnvironmentId),
});
export type MessageSender = typeof MessageSender.Type;

export const messageSender = (value: MessageSender | null | undefined): MessageSender => ({
  ...(value?.senderThreadId === undefined ? {} : { senderThreadId: value.senderThreadId }),
  ...(value?.senderEnvironmentId === undefined
    ? {}
    : { senderEnvironmentId: value.senderEnvironmentId }),
});

export const FORWARDED_SENDER_HEADER = "t3-thread-sender";
export const ForwardedThreadSender = Schema.Struct({
  threadId: ThreadId,
  environmentId: EnvironmentId,
});
export type ForwardedThreadSender = typeof ForwardedThreadSender.Type;

export const messageSenderRef = (
  value: MessageSender | null | undefined,
  environmentId: EnvironmentId,
) =>
  value?.senderThreadId === undefined
    ? null
    : {
        environmentId: value.senderEnvironmentId ?? environmentId,
        threadId: value.senderThreadId,
      };
