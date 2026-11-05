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

type AdmittedCommand =
  | { readonly type: "host"; readonly line: string }
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

const isRemoteLoadableUrl = (raw: string) => {
  const url = URL.parse(raw);
  return (
    url !== null &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    !isLoopbackAddressHost(url.hostname)
  );
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
    return allowed.show && isRemoteLoadableUrl(url)
      ? Option.some<AdmittedCommand>({ type: "navigate", tabId, url })
      : Option.none<AdmittedCommand>();
  }
  const inner = parseObject(command.value.line);
  if (!allowed.control || !inner || typeof inner.threadId !== "string") {
    return Option.none<AdmittedCommand>();
  }
  const line = encodeJson({
    ...inner,
    threadId: remoteDesktopBrowserThreadId(command.value.environmentId, inner.threadId),
  });
  return Option.some<AdmittedCommand>({ type: "host", line });
});

export const remoteEventEnvelope = (text: string) => {
  const event = parseObject(text);
  if (!event || typeof event.threadId !== "string") return undefined;
  const scope = parseRemoteDesktopBrowserThreadId(event.threadId);
  if (!scope) return undefined;
  return JSON.stringify({
    environmentId: scope.environmentId,
    line: JSON.stringify({ ...event, threadId: scope.threadId }),
  });
};
