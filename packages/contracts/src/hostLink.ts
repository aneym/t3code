import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HOST_LINK_PROTOCOL = "t3-host-link/1";

export const HostLinkLane = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export type HostLinkLane = typeof HostLinkLane.Type;

export const HostLinkLaneBinding = Schema.Struct({
  threadId: ThreadId,
  lane: HostLinkLane,
  boundAt: Schema.String,
});
export type HostLinkLaneBinding = typeof HostLinkLaneBinding.Type;

export const HostLinkBindInput = Schema.Struct({
  threadId: Schema.optional(ThreadId).annotate({
    description: "Thread to bind. Defaults to the calling thread.",
  }),
  lane: Schema.NullOr(HostLinkLane).annotate({
    description: "The host app's lane id for this thread, or null to unbind.",
  }),
});
export type HostLinkBindInput = typeof HostLinkBindInput.Type;

export const HostLinkBindResult = Schema.Struct({
  threadId: ThreadId,
  lane: Schema.NullOr(HostLinkLane),
});
export type HostLinkBindResult = typeof HostLinkBindResult.Type;

export const HostLinkConnectionState = Schema.Literals(["off", "connecting", "open", "backoff"]);
export type HostLinkConnectionState = typeof HostLinkConnectionState.Type;

export const HostLinkStatusInput = Schema.Struct({
  threadId: Schema.optional(ThreadId).annotate({
    description: "Only this thread's lane in `lanes`.",
  }),
});
export type HostLinkStatusInput = typeof HostLinkStatusInput.Type;

export const HostLinkPeerState = Schema.Literals(["up", "down"]);
export type HostLinkPeerState = typeof HostLinkPeerState.Type;

export const HostLinkPeerDownReason = Schema.Literals(["unreachable", "expired"]);
export type HostLinkPeerDownReason = typeof HostLinkPeerDownReason.Type;

export const HostLinkPeerHealth = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  state: HostLinkPeerState,
  reason: Schema.NullOr(HostLinkPeerDownReason),
  since: Schema.String,
});
export type HostLinkPeerHealth = typeof HostLinkPeerHealth.Type;

export const HostLinkStatus = Schema.Struct({
  enabled: Schema.Boolean,
  url: Schema.String,
  state: HostLinkConnectionState,
  connectedAt: Schema.NullOr(Schema.String),
  lastHeardAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  reconnects: Schema.Number,
  unacked: Schema.Number,
  lanes: Schema.Array(HostLinkLaneBinding),
  peers: Schema.Array(HostLinkPeerHealth),
});
export type HostLinkStatus = typeof HostLinkStatus.Type;

export const HostLinkEventKind = Schema.Literals([
  "started",
  "message",
  "step",
  "done",
  "ended",
  "reopened",
  "peer_down",
  "peer_up",
]);
export type HostLinkEventKind = typeof HostLinkEventKind.Type;

export const HostLinkInboundFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["ping", "pong"]) }),
  Schema.Struct({ type: Schema.Literal("ack"), seq: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("bind"),
    threadId: ThreadId,
    lane: Schema.NullOr(HostLinkLane),
  }),
]);
export type HostLinkInboundFrame = typeof HostLinkInboundFrame.Type;
