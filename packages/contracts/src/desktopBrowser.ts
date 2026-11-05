import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const TabKey = {
  threadId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
};

export const DesktopBrowserEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("attached"), ...TabKey }),
  /** Its `<webview>` went away: closed, crashed, swapped, or devtools took the debugger. */
  Schema.Struct({ type: Schema.Literal("detached"), ...TabKey }),
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
]);
export type DesktopBrowserEvent = typeof DesktopBrowserEvent.Type;

export const DesktopBrowserCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("release"), ...TabKey }),
  Schema.Struct({
    type: Schema.Literal("pointer"),
    ...TabKey,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
  }),
  /** Whether an agent turn runs on the thread, so the tabs it uses stay focused between steps. */
  Schema.Struct({
    type: Schema.Literal("turn"),
    threadId: TrimmedNonEmptyString,
    active: Schema.Boolean,
  }),
]);
export type DesktopBrowserCommand = typeof DesktopBrowserCommand.Type;

export const DesktopBrowserAnnounce = Schema.Struct({ type: Schema.Literal("announce") });
export type DesktopBrowserAnnounce = typeof DesktopBrowserAnnounce.Type;

export const DesktopBrowserRemoteSource = Schema.Struct({
  deviceName: TrimmedNonEmptyString,
  focused: Schema.Boolean,
  control: Schema.optionalKey(Schema.Boolean),
});
export type DesktopBrowserRemoteSource = typeof DesktopBrowserRemoteSource.Type;

export const DesktopBrowserRemoteEvents = Schema.Struct({
  deviceName: TrimmedNonEmptyString,
  focused: Schema.optional(Schema.Boolean),
  events: Schema.Array(Schema.String),
});
export type DesktopBrowserRemoteEvents = typeof DesktopBrowserRemoteEvents.Type;

export const DesktopBrowserRendererCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("remote"),
    environmentId: Schema.String,
    line: Schema.String,
    loopbackHost: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("mirror"), tabId: Schema.String, url: Schema.String }),
]);
export type DesktopBrowserRendererCommand = typeof DesktopBrowserRendererCommand.Type;

export const DesktopBrowserRemoteEnvelope = Schema.Struct({
  environmentId: Schema.String,
  line: Schema.String,
});
export type DesktopBrowserRemoteEnvelope = typeof DesktopBrowserRemoteEnvelope.Type;

export const REMOTE_DEVICE_BROWSER_PROFILE_ID = "t3:remote-device";

const REMOTE_THREAD_PREFIX = "remote\u0000";

export const remoteDesktopBrowserThreadId = (environmentId: string, threadId: string) =>
  `${REMOTE_THREAD_PREFIX}${environmentId}\u0000${threadId}`;

export const parseRemoteDesktopBrowserThreadId = (scopedThreadId: string) => {
  if (!scopedThreadId.startsWith(REMOTE_THREAD_PREFIX)) return undefined;
  const rest = scopedThreadId.slice(REMOTE_THREAD_PREFIX.length);
  const split = rest.indexOf("\u0000");
  if (split <= 0) return undefined;
  return { environmentId: rest.slice(0, split), threadId: rest.slice(split + 1) };
};
