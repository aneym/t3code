import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId } from "./baseSchemas.ts";

export const MessageSender = Schema.Struct({
  senderThreadId: Schema.optional(ThreadId),
  senderEnvironmentId: Schema.optional(EnvironmentId),
  senderEnvironmentLabel: Schema.optional(Schema.String),
});
export type MessageSender = typeof MessageSender.Type;

export const messageSender = (value: MessageSender | null | undefined): MessageSender => ({
  ...(value?.senderThreadId === undefined ? {} : { senderThreadId: value.senderThreadId }),
  ...(value?.senderEnvironmentLabel === undefined
    ? {}
    : { senderEnvironmentLabel: value.senderEnvironmentLabel }),
  ...(value?.senderEnvironmentId === undefined
    ? {}
    : { senderEnvironmentId: value.senderEnvironmentId }),
});

export const PeerIdentity = Schema.Struct({ environmentId: EnvironmentId, label: Schema.String });
export type PeerIdentity = typeof PeerIdentity.Type;

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

export const senderEnvironmentLabel = (environmentId: EnvironmentId, label?: string): string =>
  Array.from((label ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim())
    .slice(0, 80)
    .join("") || environmentId;

export const boundedPeerIdentity = (peer: PeerIdentity): PeerIdentity => ({
  environmentId: peer.environmentId,
  label: senderEnvironmentLabel(peer.environmentId, peer.label),
});
