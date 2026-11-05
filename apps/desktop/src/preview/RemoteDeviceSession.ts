import type { Event, Session, WebContents } from "electron";
import { app } from "electron";

import { isBlockedHost } from "./RemoteDeviceAddress.ts";
import * as RemoteDeviceProxy from "./RemoteDeviceProxy.ts";

const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
const LOCAL_SCHEMES = new Set(["data:", "blob:", "devtools:"]);
const BLANK_DOCUMENTS = new Set(["about:blank", "about:srcdoc"]);

const guardedSessions = new WeakSet<Session>();
const guarding = new WeakMap<Session, Promise<void>>();
let listening = false;

export const isNavigableUrl = (raw: string) => {
  if (BLANK_DOCUMENTS.has(raw)) return true;
  const url = URL.parse(raw);
  return (
    url !== null &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    !isBlockedHost(url.hostname)
  );
};

const allowsRequest = (raw: string) => {
  const url = URL.parse(raw);
  if (url === null) return false;
  if (LOCAL_SCHEMES.has(url.protocol)) return true;
  return NETWORK_SCHEMES.has(url.protocol) && !isBlockedHost(url.hostname);
};

const guardContents = (contents: WebContents) => {
  const refuse = (event: Event<{ readonly url: string }>) => {
    if (!isNavigableUrl(event.url)) event.preventDefault();
  };
  contents.on("will-navigate", refuse);
  contents.on("will-frame-navigate", refuse);
  contents.on("will-redirect", refuse);
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
};

const install = async (session: Session) => {
  const proxyPort = await RemoteDeviceProxy.port();
  await session.setProxy({
    proxyRules: `127.0.0.1:${proxyPort}`,
    proxyBypassRules: "<-loopback>",
  });
  session.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !allowsRequest(details.url) }),
  );
  session.on("will-download", (event) => event.preventDefault());
  guardedSessions.add(session);
  if (listening) return;
  listening = true;
  app.on("web-contents-created", (_event, contents) => {
    if (guardedSessions.has(contents.session)) guardContents(contents);
  });
};

export const guard = (session: Session) => {
  const pending = guarding.get(session) ?? install(session);
  guarding.set(session, pending);
  return pending;
};
