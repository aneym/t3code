import {
  type ClientSettings,
  DesktopBrowserRendererCommand,
  parseRemoteDesktopBrowserThreadId,
  remoteDesktopBrowserThreadId,
} from "@t3tools/contracts";
import { isLoopbackAddressHost } from "@t3tools/shared/hostClassification";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as RemoteDeviceSession from "./RemoteDeviceSession.ts";

type AdmittedCommand =
  | { readonly type: "host"; readonly line: string }
  | { readonly type: "reply"; readonly line: string }
  | { readonly type: "navigate"; readonly tabId: string; readonly url: string };

const decodeRendererCommand = Schema.decodeUnknownOption(
  Schema.fromJsonString(DesktopBrowserRendererCommand),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const parseObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const remoteTargetUrl = (raw: string, loopbackHost: string | undefined) => {
  if (RemoteDeviceSession.isNavigableUrl(raw)) return raw;
  const url = URL.parse(raw);
  if (url === null || !isLoopbackAddressHost(url.hostname)) return undefined;
  if (loopbackHost === undefined || RemoteDeviceSession.isBlockedHost(loopbackHost)) {
    return undefined;
  }
  url.hostname = loopbackHost;
  return RemoteDeviceSession.isNavigableUrl(url.href) ? url.href : undefined;
};

const scopeCdpLine = (
  inner: Record<string, unknown>,
  environmentId: string,
  loopbackHost: string | undefined,
): AdmittedCommand | undefined => {
  const scoped = (fields: Record<string, unknown>) =>
    encodeJson({
      ...inner,
      ...fields,
      threadId: remoteDesktopBrowserThreadId(environmentId, inner.threadId as string),
    });
  if (inner.type !== "cdp" || typeof inner.message !== "string") {
    return { type: "host", line: scoped({}) };
  }
  const message = parseObject(inner.message);
  const params = message?.params;
  if (!message || typeof params !== "object" || params === null) {
    return { type: "host", line: scoped({}) };
  }
  const raw = (params as Record<string, unknown>).url;
  if (typeof raw !== "string") return { type: "host", line: scoped({}) };
  const url = remoteTargetUrl(raw, loopbackHost);
  if (url !== undefined) {
    const rewritten = encodeJson({ ...message, params: { ...params, url } });
    return { type: "host", line: scoped({ message: rewritten }) };
  }
  if (message.id === undefined) return undefined;
  const error = encodeJson({
    id: message.id,
    error: { code: -32000, message: `Remote agents cannot open ${raw} on this device.` },
    ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
  });
  const event = encodeJson({
    type: "cdp",
    threadId: inner.threadId,
    tabId: inner.tabId,
    message: error,
  });
  return { type: "reply", line: encodeJson({ environmentId, line: event }) };
};

const grants = (settings: Option.Option<ClientSettings>) =>
  Option.match(settings, {
    onNone: () => ({ show: false, control: false }),
    onSome: (value) => ({
      show: value.browserAllowRemoteDeviceTabs,
      control: value.browserAllowRemoteDeviceTabs && value.browserAllowRemoteDeviceControl,
    }),
  });

export const admit = Effect.fn("desktop.remoteBrowserScope.admit")(function* (text: string) {
  const command = decodeRendererCommand(text);
  if (Option.isNone(command)) return Option.none<AdmittedCommand>();
  const store = yield* DesktopClientSettings.DesktopClientSettings;
  const allowed = grants(yield* store.get.pipe(Effect.orElseSucceed(() => Option.none())));
  if (command.value.type === "mirror") {
    const { tabId, url } = command.value;
    return allowed.show && RemoteDeviceSession.isNavigableUrl(url)
      ? Option.some<AdmittedCommand>({ type: "navigate", tabId, url })
      : Option.none<AdmittedCommand>();
  }
  const inner = parseObject(command.value.line);
  if (!allowed.control || !inner || typeof inner.threadId !== "string") {
    return Option.none<AdmittedCommand>();
  }
  return Option.fromUndefinedOr(
    scopeCdpLine(inner, command.value.environmentId, command.value.loopbackHost),
  );
});

export const remoteEventEnvelope = (text: string) => {
  const event = parseObject(text);
  if (!event || typeof event.threadId !== "string") return undefined;
  const scope = parseRemoteDesktopBrowserThreadId(event.threadId);
  if (!scope) return undefined;
  return encodeJson({
    environmentId: scope.environmentId,
    line: encodeJson({ ...event, threadId: scope.threadId }),
  });
};
