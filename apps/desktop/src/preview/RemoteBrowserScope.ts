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
import { isBlockedHost } from "./RemoteDeviceAddress.ts";
import * as RemoteCdpMethods from "./RemoteCdpMethods.ts";
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

const HOST_COMMANDS = new Set(["cdp", "release", "pointer", "turn"]);

const remoteTargetUrl = (raw: string, loopbackHost: string | undefined) => {
  if (RemoteDeviceSession.isNavigableUrl(raw)) return raw;
  const url = URL.parse(raw);
  if (url === null || !isLoopbackAddressHost(url.hostname)) return undefined;
  if (loopbackHost === undefined || isBlockedHost(loopbackHost)) return undefined;
  url.hostname = loopbackHost;
  return RemoteDeviceSession.isNavigableUrl(url.href) ? url.href : undefined;
};

const refusal = (
  inner: Record<string, unknown>,
  environmentId: string,
  message: Record<string, unknown>,
  reason: string,
): AdmittedCommand | undefined => {
  if (message.id === undefined) return undefined;
  const error = encodeJson({
    id: message.id,
    error: { code: -32000, message: `Remote agents cannot ${reason} on this device.` },
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

const scopeHostLine = (
  inner: Record<string, unknown>,
  environmentId: string,
  loopbackHost: string | undefined,
): AdmittedCommand | undefined => {
  if (typeof inner.type !== "string" || !HOST_COMMANDS.has(inner.type)) return undefined;
  const scoped = (fields: Record<string, unknown>): AdmittedCommand => ({
    type: "host",
    line: encodeJson({
      ...inner,
      ...fields,
      threadId: remoteDesktopBrowserThreadId(environmentId, inner.threadId as string),
    }),
  });
  if (inner.type !== "cdp") return scoped({});
  const message = typeof inner.message === "string" ? parseObject(inner.message) : undefined;
  if (!message || typeof message.method !== "string") return undefined;
  const method = message.method;
  if (!RemoteCdpMethods.isAllowed(method)) {
    return refusal(inner, environmentId, message, `call ${method}`);
  }
  const raw = message.params;
  const given = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const params = RemoteCdpMethods.remoteParams(method, given);
  const target = (params as Record<string, unknown>).url;
  if (typeof target !== "string") {
    return scoped({ message: encodeJson({ ...message, params }) });
  }
  const url = remoteTargetUrl(target, loopbackHost);
  if (url === undefined) return refusal(inner, environmentId, message, `open ${target}`);
  return scoped({ message: encodeJson({ ...message, params: { ...params, url } }) });
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
    scopeHostLine(inner, command.value.environmentId, command.value.loopbackHost),
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
