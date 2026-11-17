import * as Schema from "effect/Schema";

export const RAILS_AGENT_ID_PATTERN = /^[0-9a-f]{12}$/;

export const DesktopRailsWordsNotice = Schema.Literals([
  "removed-in-rails",
  "disconnected",
  "disconnected-here",
  "connect-refused",
  "connect-failed",
  "connect-full",
  "storage-unavailable",
]);
export type DesktopRailsWordsNotice = typeof DesktopRailsWordsNotice.Type;

export const DesktopRailsWordsState = Schema.Struct({
  connected: Schema.Boolean,
  deviceName: Schema.NullOr(Schema.String),
  personName: Schema.NullOr(Schema.String),
  connectedAt: Schema.NullOr(Schema.String),
  lastSentAt: Schema.NullOr(Schema.String),
  unreachableSince: Schema.NullOr(Schema.String),
  notice: Schema.NullOr(DesktopRailsWordsNotice),
});
export type DesktopRailsWordsState = typeof DesktopRailsWordsState.Type;

export const DesktopRailsWordsSaid = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
  agent: Schema.String.check(Schema.isPattern(RAILS_AGENT_ID_PATTERN)),
  messageId: Schema.String,
  text: Schema.String,
  typedAt: Schema.String,
});
export type DesktopRailsWordsSaid = typeof DesktopRailsWordsSaid.Type;

export interface DesktopRailsWordsBridge {
  getState: () => Promise<DesktopRailsWordsState>;
  onState: (listener: (state: DesktopRailsWordsState) => void) => () => void;
  said: (input: DesktopRailsWordsSaid) => void;
  disconnect: () => Promise<DesktopRailsWordsState>;
}
