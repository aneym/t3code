import * as Schema from "effect/Schema";

const EMBED_ROUTE_MESSAGE = "t3-embed/route";
const EMBED_WARM_MESSAGE = "t3-embed/warm";
export const EMBED_ROUTE_REFUSED_MESSAGE = "t3-embed/route-refused";
export const EMBED_READY_MESSAGE = "t3-embed/ready";

export const EMBED_WARM_LIMIT = 8;

export const EmbedCapability = Schema.Literals(["route", "warm"]);
export type EmbedCapability = typeof EmbedCapability.Type;

export const EMBED_CAPABILITIES: ReadonlyArray<EmbedCapability> = ["route", "warm"];

export const EmbedPaintSource = Schema.Literals(["memory", "kept", "live"]);
export type EmbedPaintSource = typeof EmbedPaintSource.Type;

const EmbedThread = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9:._-]{1,128}$/));

export const EmbedRouteMessage = Schema.Struct({
  type: Schema.Literal(EMBED_ROUTE_MESSAGE),
  thread: EmbedThread,
});
export type EmbedRouteMessage = typeof EmbedRouteMessage.Type;

export const EmbedWarmMessage = Schema.Struct({
  type: Schema.Literal(EMBED_WARM_MESSAGE),
  threads: Schema.Array(EmbedThread).check(Schema.isMaxLength(EMBED_WARM_LIMIT)),
});
export type EmbedWarmMessage = typeof EmbedWarmMessage.Type;

export const EmbedRouteRefusal = Schema.Literals(["not-visible", "not-synced"]);
export type EmbedRouteRefusal = typeof EmbedRouteRefusal.Type;

export const EmbedRouteRefusedMessage = Schema.Struct({
  type: Schema.Literal(EMBED_ROUTE_REFUSED_MESSAGE),
  thread: Schema.String,
  reason: EmbedRouteRefusal,
});
export type EmbedRouteRefusedMessage = typeof EmbedRouteRefusedMessage.Type;

export const EmbedRouteTimings = Schema.Struct({
  navigate: Schema.Number,
  mounted: Schema.Number,
  drawn: Schema.Number,
  ready: Schema.Number,
});
export type EmbedRouteTimings = typeof EmbedRouteTimings.Type;

export const EmbedReadyMessage = Schema.Struct({
  type: Schema.Literal(EMBED_READY_MESSAGE),
  threadId: Schema.String,
  from: EmbedPaintSource,
  capabilities: Schema.Array(EmbedCapability),
  timings: Schema.optionalKey(EmbedRouteTimings),
});
export type EmbedReadyMessage = typeof EmbedReadyMessage.Type;
